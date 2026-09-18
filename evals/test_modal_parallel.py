import argparse
import asyncio
import json
import os
import tempfile
import time
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import AsyncMock, patch

from harbor.models.trial.config import TrialConfig

from evals.full import save
from evals.harbor_agent import JevClaudeCode
from evals.modal_runner import (
    eligible_rows,
    ensure_budget,
    execute,
    fits_before_refresh,
    preflight_manifest,
)


class ParallelTests(unittest.IsolatedAsyncioTestCase):
    def test_arms_are_instance_local_and_override_process_environment(self) -> None:
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {"JEV_EVAL_ARM": "plugin"}),
        ):
            control = JevClaudeCode(
                logs_dir=Path(directory),
                model_name="anthropic/frozen",
                eval_arm="control",
            )
            plugin = JevClaudeCode(
                logs_dir=Path(directory),
                model_name="anthropic/frozen",
                eval_arm="plugin",
            )
            self.assertNotIn("/production", control.build_cli_flags())
            self.assertIn("/production", plugin.build_cli_flags())
            os.environ["JEV_EVAL_ARM"] = "control"
            self.assertIn("/production", plugin.build_cli_flags())

    def test_eligible_rows_preserve_dependencies_and_skip_active_tasks(
        self,
    ) -> None:
        rows = [
            {"task": task, "arm": arm, "state": "pending"}
            for task in ("a", "b")
            for arm in ("control", "plugin")
        ]
        setups: list[dict] = [
            {"task": task, "arm": "preflight", "state": "finished"}
            for task in ("a", "b")
        ]
        spec = {
            "build_seconds": 60,
            "full_lifetime_seconds": 3600,
            "preflight_lifetime_seconds": 810,
        }
        self.assertEqual(
            [row["arm"] for row in eligible_rows(rows, setups)], ["control", "control"]
        )
        rows[0]["state"] = "running"
        setups[1]["state"] = "pending"
        self.assertEqual(
            [row["arm"] for row in eligible_rows(rows, setups)], ["preflight"]
        )
        rows[0]["state"] = "finished"
        self.assertEqual(
            [row["arm"] for row in eligible_rows(rows, setups)],
            ["plugin", "preflight"],
        )
        setups[1]["subscription_recheck"] = True
        self.assertEqual(eligible_rows(rows, setups), [setups[1]])
        setups[1].pop("subscription_recheck")
        rows[1]["state"] = "access_error"
        with self.assertRaisesRegex(ValueError, "failed trial"):
            eligible_rows(rows, setups)
        self.assertTrue(fits_before_refresh(spec, False, (time.time() + 7200) * 1000))
        self.assertFalse(fits_before_refresh(spec, False, (time.time() + 600) * 1000))
        self.assertTrue(fits_before_refresh(spec, True, (time.time() + 3600) * 1000))

    def test_no_limit_still_requires_reconciled_imports(self) -> None:
        ledger = {
            "budget_usd": None,
            "accounted_usd": 42,
            "unreconciled_import": False,
        }
        ensure_budget(ledger, 100)
        ledger["unreconciled_import"] = True
        with self.assertRaisesRegex(ValueError, "Reconcile"):
            ensure_budget(ledger, 1)

    async def test_parallel_trials_account_each_row_and_keep_pair_order(self) -> None:
        await self.exercise_wave(False)

    async def test_failed_preflight_drains_peers_and_stops_inference(self) -> None:
        await self.exercise_wave(True)

    async def test_fast_failure_stops_refill_and_drains_a_slow_peer(self) -> None:
        await self.exercise_wave(True, fail_task="b")

    async def test_free_slots_refill_while_a_slow_trial_runs(self) -> None:
        await self.exercise_wave(False, tasks=("a", "b", "c", "d"))

    async def test_account_limit_stops_new_work(self) -> None:
        await self.exercise_wave(False, blocked=True)

    async def test_all_32_slots_can_run(self) -> None:
        await self.exercise_wave(
            False, tasks=tuple(f"task{i}" for i in range(32)), concurrency=32
        )

    async def test_near_expiry_runs_alone(self) -> None:
        await self.exercise_wave(False, expiry_seconds=600)

    async def test_subscription_recheck_runs_alone(self) -> None:
        await self.exercise_wave(False, recheck=True)

    async def test_scheduler_budget_failure_drains_active_trials(self) -> None:
        await self.exercise_wave(False, budget=0.8)

    async def test_billing_failure_drains_active_trials(self) -> None:
        await self.exercise_wave(False, billing_failure=True)

    async def test_concurrency_above_the_supported_maximum_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "Concurrency 1–32"):
            await self.exercise_wave(False, concurrency=33)

    async def exercise_wave(
        self,
        fail: bool,
        tasks: tuple[str, ...] = ("a", "b"),
        concurrency: int = 2,
        blocked: bool = False,
        expiry_seconds: int = 7200,
        recheck: bool = False,
        budget: float | None = None,
        billing_failure: bool = False,
        fail_task: str = "a",
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = root / "plan"
            plan.mkdir()
            evidence = root / "evidence"
            specs = [
                {
                    "task": task,
                    "image": f"fixture/{task}",
                    "build_seconds": 3,
                    "preflight_lifetime_seconds": 10,
                    "full_lifetime_seconds": 20,
                    "runtime_usd_per_second": 0.01,
                }
                for task in tasks
            ]
            rows = [
                {
                    "task": task,
                    "arm": arm,
                    "state": "pending",
                    "job_name": f"{task}-{arm}",
                    "reward": None,
                }
                for task in tasks
                for arm in ("control", "plugin")
            ]
            document = {"tasks": specs, "trials": rows, "provenance": {"frozen": True}}
            save(plan / "plan.json", document)
            args = argparse.Namespace(
                command="campaign",
                approve_modal_compute=True,
                approve_inference=True,
                no_budget_limit=budget is None,
                budget_usd=budget,
                concurrency=concurrency,
                checkpoint_tasks=len(tasks),
                build_reserve_usd=0.25,
                prior_accounted_usd=0,
                billing_start_date=date(2026, 9, 18),
                seed_preflight=None,
                continue_from=None,
                evidence=evidence,
                benchmark_source=root / "benchmark",
                plan=plan,
                resume=False,
                observed_total_usd=None,
            )
            active, peak = 0, 0
            started = []
            completed: list[str] = []
            activity = []
            expected_error = budget is not None or billing_failure
            refilled = asyncio.Event()
            test_refill = tasks == ("a", "b", "c", "d")

            class Environment:
                def __init__(self, config: TrialConfig):
                    self.config = config

                async def stop(self, delete: bool) -> None:
                    location = evidence / "trials" / self.config.trial_name
                    save(
                        location / "modal-lifecycle.json",
                        {
                            "modal_image_id": f"im-{self.config.task.path.name}",
                            "evidence_verified": True,
                            "termination_confirmed": True,
                            "subscription_state_saved": True,
                            "elapsed_seconds": 2
                            if self.config.agent.kwargs["eval_arm"] == "plugin"
                            else 1,
                        },
                    )

            class FakeTrial:
                def __init__(self, config: TrialConfig):
                    self.config = config
                    self.agent_environment = Environment(config)

                async def run(self) -> None:
                    nonlocal active, peak
                    active += 1
                    peak = max(active, peak)
                    started.append(self.config.trial_name)
                    activity.append(("start", self.config.trial_name))
                    ledger = json.loads((evidence / "budget.json").read_text())
                    reserved = sum(
                        row.get("reserved_usd", 0)
                        for path in ("progress.json", "preflight-progress.json")
                        for row in json.loads((evidence / path).read_text())
                        if row["state"] in {"scheduled", "resolving_image", "running"}
                    )
                    self_outer.assertGreaterEqual(
                        ledger["accounted_usd"] + 1e-9, reserved
                    )
                    if test_refill and self.config.trial_name == "c-preflight":
                        refilled.set()
                    if test_refill and self.config.trial_name == "a-preflight":
                        await asyncio.wait_for(refilled.wait(), timeout=10)
                    else:
                        await asyncio.sleep(
                            0.05 if self.config.task.path.name == "a" else 0
                        )
                    location = evidence / "trials" / self.config.trial_name
                    (location / "agent/jev").mkdir(parents=True)
                    (location / "verifier").mkdir()
                    for name in ("eval-settings.json", "modal-preflight.json"):
                        save(location / "agent" / name, {})
                    (location / "agent/claude-code.txt").write_text(
                        json.dumps(
                            {
                                "type": "rate_limit_event",
                                "rate_limit_info": {"status": "rejected"},
                            }
                        )
                        if blocked and self.config.trial_name == "a-control"
                        else ""
                    )
                    save(location / "agent/jev/activated.json", {})
                    (location / "verifier/reward.txt").write_text("1")
                    save(
                        location / "result.json",
                        {
                            "agent_execution": not self.config.install_only,
                            "verifier": not self.config.install_only,
                            "exception_info": {"exception_type": "FixtureAuthError"}
                            if fail
                            and self.config.trial_name == f"{fail_task}-preflight"
                            else None,
                        },
                    )
                    active -= 1
                    completed.append(self.config.trial_name)
                    activity.append(("end", self.config.trial_name))

            async def create(config: TrialConfig) -> FakeTrial:
                return FakeTrial(config)

            async def reconcile(ledger: dict, start: object) -> None:
                if billing_failure and completed:
                    raise ValueError("Fixture billing unavailable")
                ledger["unreconciled_import"] = False

            def preflights(specs: list[dict]) -> list[dict]:
                result = preflight_manifest(specs)
                if recheck:
                    result[0]["subscription_recheck"] = True
                return result

            def summary(path: Path) -> dict:
                task, arm = path.parent.name.split("-")
                return {
                    "task": task,
                    "arm": arm,
                    "exception": None,
                    "exception_phase": None,
                    "measurement_issues": [],
                    "reward": 1,
                }

            self_outer = self
            with (
                patch.dict(
                    os.environ,
                    {
                        "JEV_EVAL_AUTH_MODE": "subscription",
                        "TYPESAFE_API_KEY": "fixture",
                    },
                ),
                patch(
                    "evals.modal_runner.provenance", return_value=document["provenance"]
                ),
                patch("evals.modal_runner.subscription_source", return_value=root),
                patch("evals.modal_runner.SubscriptionCheckpoint") as checkpoint,
                patch(
                    "evals.modal_runner.resolve_image", return_value={"oci": "fixture"}
                ),
                patch(
                    "evals.modal_runner.Trial.create", new=AsyncMock(side_effect=create)
                ),
                patch("evals.modal_runner.refresh_budget", new=reconcile),
                patch("evals.modal_runner.preflight_manifest", side_effect=preflights),
                patch("evals.modal_runner.summarize_trial", side_effect=summary),
                patch(
                    "evals.modal_runner.ensure_budget", wraps=ensure_budget
                ) as reserve,
            ):
                checkpoint.return_value.expires_at = (
                    time.time() + expiry_seconds
                ) * 1000
                if expected_error:
                    with self.assertRaises((RuntimeError, ValueError)):
                        await execute(args)
                else:
                    await execute(args)
            self.assertEqual(active, 0)
            self.assertEqual(set(started), set(completed))
            for name in started:
                lifecycle = json.loads(
                    (evidence / "trials" / name / "modal-lifecycle.json").read_text()
                )
                self.assertTrue(lifecycle["termination_confirmed"])
            if expected_error:
                self.assertEqual(set(started), {"a-preflight", "b-preflight"})
                self.assertFalse((evidence / "small-results.json").exists())
                return
            if blocked:
                progress = {
                    row["job_name"]: row
                    for row in json.loads((evidence / "progress.json").read_text())
                }
                self.assertEqual(progress["a-control"]["state"], "finished")
                self.assertNotIn("a-plugin", started)
                self.assertFalse((evidence / "small-results.json").exists())
                return
            self.assertEqual(
                peak, 1 if expiry_seconds == 600 else min(concurrency, len(tasks))
            )
            if recheck:
                self.assertEqual(
                    activity[:2], [("start", "a-preflight"), ("end", "a-preflight")]
                )
            if fail:
                self.assertEqual(
                    set(started),
                    {"a-preflight", "b-preflight", "b-control", "b-plugin"}
                    if fail_task == "a"
                    else {"a-preflight", "b-preflight"},
                )
                self.assertFalse((evidence / "small-results.json").exists())
                for name in started:
                    lifecycle = json.loads(
                        (
                            evidence / "trials" / name / "modal-lifecycle.json"
                        ).read_text()
                    )
                    self.assertTrue(lifecycle["termination_confirmed"])
                states = {
                    row["job_name"]: row["state"]
                    for row in json.loads((evidence / "progress.json").read_text())
                }
                self.assertEqual(states["a-control"], "pending")
                self.assertEqual(states["a-plugin"], "pending")
                self.assertEqual(
                    states["b-plugin"], "finished" if fail_task == "a" else "pending"
                )
                return
            self.assertEqual(reserve.call_count, 3 * len(tasks))
            if tasks == ("a", "b", "c", "d"):
                self.assertLess(
                    activity.index(("start", "c-preflight")),
                    activity.index(("end", "a-preflight")),
                )
            for task in tasks:
                self.assertLess(
                    started.index(f"{task}-preflight"), started.index(f"{task}-control")
                )
                self.assertLess(
                    started.index(f"{task}-control"), started.index(f"{task}-plugin")
                )
            ledger = json.loads((evidence / "budget.json").read_text())
            self.assertAlmostEqual(
                ledger["accounted_usd"], 0.29 * len(tasks) - (0.25 if recheck else 0)
            )
            for entry in ledger["entries"]:
                self.assertAlmostEqual(
                    entry["runtime_estimate_usd"],
                    0.02 if entry["arm"] == "plugin" else 0.01,
                )
            small = json.loads((evidence / "small-results.json").read_text())
            self.assertEqual(len(small["trials"]), 2 * len(tasks))
            self.assertTrue(
                all(pair["both_rewards_available"] for pair in small["pairs"])
            )


if __name__ == "__main__":
    unittest.main()
