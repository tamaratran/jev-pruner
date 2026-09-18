import json
import tempfile
import unittest
from pathlib import Path

from evals.full import access_blocker, aggregate, failure_category, trial_blocker
from evals.summarize import summarize_trial


class FullTests(unittest.TestCase):
    def test_summary_preserves_setup_phase_for_generic_exceptions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            trial = Path(directory) / "full-task-control" / "trial"
            trial.mkdir(parents=True)
            path = trial / "result.json"
            value = {
                "task_name": "task",
                "trial_name": "trial",
                "task_id": {"git_commit_id": "revision"},
                "task_checksum": "checksum",
                "exception_info": {"exception_type": "RuntimeError"},
                "environment_setup": {"started_at": "2026-09-18T08:00:00Z"},
            }
            path.write_text(json.dumps(value))
            self.assertEqual(
                summarize_trial(path)["exception_phase"], "environment_setup"
            )
            path.write_text(
                json.dumps(
                    {
                        **value,
                        "agent_setup": {"started_at": "2026-09-18T08:01:00Z"},
                    }
                )
            )
            self.assertEqual(summarize_trial(path)["exception_phase"], "agent_setup")

    def test_setup_errors_stop_without_inference_events(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            trial = job / "trial"
            trial.mkdir()
            for text in (
                "Docker compose failed: 429 Too Many Requests",
                "Command failed: test ! -e /opt/jev-eval/auth",
            ):
                (trial / "result.json").write_text(
                    json.dumps(
                        {
                            "exception_info": {"exception_message": text},
                            "agent_execution": None,
                        }
                    )
                )
                self.assertIsNotNone(trial_blocker(job))
            (trial / "result.json").write_text("{")
            self.assertIsNone(trial_blocker(job))
        self.assertEqual(
            failure_category(
                {
                    "exception": {"exception_type": "RuntimeError"},
                    "exception_phase": "environment_setup",
                }
            ),
            "infrastructure",
        )
        self.assertEqual(
            failure_category(
                {
                    "exception": {"exception_type": "NonZeroAgentExitCodeError"},
                    "exception_phase": "agent_setup",
                }
            ),
            "agent_setup",
        )

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
