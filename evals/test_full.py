import json
import tempfile
import unittest
from pathlib import Path

from evals.full import (
    access_blocker,
    aggregate,
    failure_category,
    next_pending,
    trial_blocker,
    validate_manifest,
)


class FullTests(unittest.TestCase):
    def test_repetitions_are_explicit_paired_and_never_overwritten(self) -> None:
        rows = [
            {
                "task": "same",
                "repetition": repetition,
                "arm": arm,
                "job_name": f"same-{repetition}-{arm}",
                "state": "pending",
            }
            for repetition in (1, 2)
            for arm in ("control", "plugin")
        ]
        validate_manifest(rows, task_count=1, repetitions=2)
        with self.assertRaises(ValueError):
            validate_manifest(rows, task_count=1)
        with self.assertRaises(ValueError):
            validate_manifest([*rows[:3], {**rows[3], "repetition": 1}], 1, 2)
        rows[0]["state"] = "running"
        self.assertEqual(next_pending(rows), 2)
        rows[0].update(state="finished", reward=1, claude_cost_usd_reported=2)
        rows[1].update(state="finished", reward=0, claude_cost_usd_reported=3)
        rows[2].update(state="finished", reward=0, claude_cost_usd_reported=4)
        rows[3].update(state="finished", reward=1, claude_cost_usd_reported=5)
        summary = aggregate(rows)
        self.assertEqual(len(summary["pairs"]), 2)
        self.assertEqual([row["control_reward"] for row in summary["pairs"]], [1, 0])
        self.assertEqual([row["plugin_reward"] for row in summary["pairs"]], [0, 1])
        self.assertEqual(
            summary["aggregate"]["control"]["claude_estimated_usd_known"], 6
        )
        self.assertEqual(
            summary["aggregate"]["plugin"]["claude_estimated_usd_known"], 8
        )

    def test_subset_requires_explicit_size_and_complete_unique_pairs(self) -> None:
        manifest = [
            {"task": task, "arm": arm, "job_name": f"{task}-{arm}"}
            for task in ("one", "two")
            for arm in ("control", "plugin")
        ]
        validate_manifest(manifest, task_count=2)
        with self.assertRaisesRegex(ValueError, "Expected 89 tasks"):
            validate_manifest(manifest)
        with self.assertRaisesRegex(ValueError, "Expected 3 tasks"):
            validate_manifest(manifest, task_count=3)
        for malformed in (
            [*manifest[:-1], manifest[-2]],
            [{**row, "arm": "other"} for row in manifest],
            [{**row, "job_name": "same"} for row in manifest],
        ):
            with self.subTest(manifest=malformed), self.assertRaises(ValueError):
                validate_manifest(malformed, task_count=2)
        with self.assertRaises(ValueError):
            validate_manifest([], task_count=0)

    def test_install_exit_errors_are_setup_failures_only_before_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            trial = job / "trial"
            trial.mkdir()
            exception = {"exception_type": "NonZeroAgentExitCodeError"}
            for execution, expected in (
                (None, "agent_setup"),
                ({"started_at": "2026-01-01T00:01:00Z"}, "agent"),
            ):
                with self.subTest(execution=execution):
                    timings = {
                        "agent_setup": {"started_at": "2026-01-01T00:00:00Z"},
                        "agent_execution": execution,
                    }
                    (trial / "result.json").write_text(
                        json.dumps({**timings, "exception_info": exception})
                    )
                    self.assertEqual(
                        failure_category({**timings, "exception": exception}), expected
                    )
                    if expected == "agent_setup":
                        self.assertIn("agent_setup", trial_blocker(job) or "")
                    else:
                        self.assertIsNone(trial_blocker(job))

    def test_setup_and_environment_errors_stop_subsequent_trials(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            trial = job / "trial"
            trial.mkdir()
            for kind, expected in (
                ("AgentSetupTimeoutError", "agent_setup"),
                ("EnvironmentStartError", "infrastructure"),
                ("AgentTimeoutError", None),
                ("VerifierTimeoutError", None),
            ):
                with self.subTest(kind=kind):
                    (trial / "result.json").write_text(
                        json.dumps({"exception_info": {"exception_type": kind}})
                    )
                    reason = trial_blocker(job)
                    if expected is None:
                        self.assertIsNone(reason)
                    else:
                        self.assertIsNotNone(reason)
                        self.assertIn(expected, reason or "")

    def test_account_errors_stop_but_task_text_does_not(self) -> None:
        self.assertIsNone(
            access_blocker(
                [
                    {
                        "type": "user",
                        "message": {"content": "Simulate an OAuth token rate limit"},
                    }
                ]
            )
        )
        for event in (
            {
                "type": "assistant",
                "error": "rate_limit",
                "message": {"content": "You've hit your limit"},
            },
            {"type": "result", "is_error": True, "result": "Model does not exist"},
            {"type": "rate_limit_event", "rate_limit_info": {"status": "rejected"}},
            {"type": "system", "subtype": "init", "model": "another-model"},
        ):
            with self.subTest(event=event):
                self.assertIsNotNone(access_blocker([event]))
        self.assertIsNone(
            access_blocker(
                [
                    {
                        "type": "rate_limit_event",
                        "rate_limit_info": {"status": "allowed_warning"},
                    }
                ]
            )
        )

    def test_missing_and_blocked_trials_are_preserved_without_zero_rewards(
        self,
    ) -> None:
        rows: list[dict[str, object]] = [
            {"task": "one", "arm": "control", "state": "finished", "reward": 1},
            {"task": "one", "arm": "plugin", "state": "finished", "reward": 0},
            {"task": "two", "arm": "control", "state": "resource_blocked"},
            {"task": "two", "arm": "plugin", "state": "pending"},
        ]
        result = aggregate(rows)
        self.assertEqual(result["expected_trials"], 4)
        self.assertTrue(result["pairs"][0]["disagreement"])
        self.assertIsNone(result["pairs"][1]["disagreement"])
        self.assertIsNone(result["pairs"][1]["control_reward"])
        self.assertEqual(result["aggregate"]["control"]["resource_blocked"], 1)
        self.assertEqual(result["aggregate"]["plugin"]["not_finished"], 1)
        self.assertEqual(
            result["aggregate"]["control"]["claude_estimate_available_trials"], 0
        )
        self.assertIsNone(result["aggregate"]["control"]["subscription_billed_usd"])

    def test_failure_types_are_not_task_reward_failures(self) -> None:
        for kind, expected in (
            ("EnvironmentStartError", "infrastructure"),
            ("AgentSetupTimeoutError", "agent_setup"),
            ("VerifierTimeoutError", "verifier"),
            ("AgentTimeoutError", "agent"),
        ):
            with self.subTest(kind=kind):
                self.assertEqual(
                    failure_category({"exception": {"exception_type": kind}}),
                    expected,
                )
        self.assertEqual(failure_category({"reward": 0}), "task_failure")
        self.assertIsNone(failure_category({"reward": 1}))
