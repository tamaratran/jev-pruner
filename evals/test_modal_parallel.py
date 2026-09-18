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
from evals.modal_runner import ensure_budget, execute, ready_wave


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

    def test_ready_wave_preserves_dependencies_and_serializes_near_refresh(
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
        specs = {
            task: {
                "build_seconds": 60,
                "full_lifetime_seconds": 3600,
                "preflight_lifetime_seconds": 810,
            }
            for task in ("a", "b")
        }
        expiry = (time.time() + 7200) * 1000
        wave = ready_wave(rows, setups, specs, 3, expiry)
        self.assertEqual([row["arm"] for row in wave], ["control", "control"])
        rows[0]["state"] = "finished"
        setups[1]["state"] = "pending"
        self.assertEqual(
            [row["arm"] for row in ready_wave(rows, setups, specs, 3, expiry)],
            ["plugin", "preflight"],
        )
        self.assertEqual(
            len(ready_wave(rows, setups, specs, 3, (time.time() + 600) * 1000)),
            1,
        )
        setups[1]["subscription_recheck"] = True
        self.assertEqual(ready_wave(rows, setups, specs, 3, expiry), [setups[1]])

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

    async def test_parallel_waves_account_each_trial_and_keep_pair_order(self) -> None:
        await self.exercise_wave(False)

    async def test_failed_preflight_drains_peers_and_stops_inference(self) -> None:
        await self.exercise_wave(True)

    async def exercise_wave(self, fail: bool) -> None:
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
                for task in ("a", "b")
            ]
            rows = [
                {
                    "task": task,
                    "arm": arm,
                    "state": "pending",
                    "job_name": f"{task}-{arm}",
                    "reward": None,
                }
                for task in ("a", "b")
                for arm in ("control", "plugin")
            ]
            document = {"tasks": specs, "trials": rows, "provenance": {"frozen": True}}
            save(plan / "plan.json", document)
            args = argparse.Namespace(
                command="campaign",
                approve_modal_compute=True,
                approve_inference=True,
                no_budget_limit=True,
                budget_usd=None,
                concurrency=2,
                checkpoint_tasks=2,
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
                    await asyncio.sleep(0)
                    location = evidence / "trials" / self.config.trial_name
                    (location / "agent/jev").mkdir(parents=True)
                    (location / "verifier").mkdir()
                    for name in ("eval-settings.json", "modal-preflight.json"):
                        save(location / "agent" / name, {})
                    (location / "agent/claude-code.txt").write_text("")
                    save(location / "agent/jev/activated.json", {})
                    (location / "verifier/reward.txt").write_text("1")
                    save(
                        location / "result.json",
                        {
                            "agent_execution": not self.config.install_only,
                            "verifier": not self.config.install_only,
                            "exception_info": {"exception_type": "FixtureAuthError"}
                            if fail and self.config.trial_name == "a-preflight"
                            else None,
                        },
                    )
                    active -= 1

            async def create(config: TrialConfig) -> FakeTrial:
                return FakeTrial(config)

            async def reconcile(ledger: dict, start: object) -> None:
                ledger["unreconciled_import"] = False

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
                patch("evals.modal_runner.summarize_trial", side_effect=summary),
                patch(
                    "evals.modal_runner.ensure_budget", wraps=ensure_budget
                ) as reserve,
            ):
                checkpoint.return_value.expires_at = (time.time() + 7200) * 1000
                await execute(args)
            self.assertEqual(peak, 2)
            if fail:
                self.assertEqual(set(started), {"a-preflight", "b-preflight"})
                self.assertFalse((evidence / "small-results.json").exists())
                for name in started:
                    lifecycle = json.loads(
                        (
                            evidence / "trials" / name / "modal-lifecycle.json"
                        ).read_text()
                    )
                    self.assertTrue(lifecycle["termination_confirmed"])
                self.assertTrue(
                    all(
                        row["state"] == "pending"
                        for row in json.loads((evidence / "progress.json").read_text())
                    )
                )
                return
            self.assertEqual(reserve.call_count, 3)
            for task in ("a", "b"):
                self.assertLess(
                    started.index(f"{task}-preflight"), started.index(f"{task}-control")
                )
                self.assertLess(
                    started.index(f"{task}-control"), started.index(f"{task}-plugin")
                )
            ledger = json.loads((evidence / "budget.json").read_text())
            self.assertAlmostEqual(ledger["accounted_usd"], 0.58)
            for entry in ledger["entries"]:
                self.assertAlmostEqual(
                    entry["runtime_estimate_usd"],
                    0.02 if entry["arm"] == "plugin" else 0.01,
                )
            small = json.loads((evidence / "small-results.json").read_text())
            self.assertEqual(len(small["trials"]), 4)
            self.assertTrue(
                all(pair["both_rewards_available"] for pair in small["pairs"])
            )


if __name__ == "__main__":
    unittest.main()
