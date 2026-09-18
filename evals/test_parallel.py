import json
import os
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import Mock, patch

from evals.full import run


class ParallelTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.tick = 0
        self.peak = 0
        self.started: list[str] = []
        self.fail_setup = False
        self.missing_result = False
        self.change_sources = False
        self.manifest = [
            {
                "task": f"task-{task}",
                "arm": arm,
                "job_name": f"task-{task}-{arm}",
                "resource_blocked": task >= 3,
            }
            for task in range(89)
            for arm in ("control", "plugin")
        ]
        (self.root / "manifest.json").write_text(json.dumps(self.manifest))
        for task in range(3):
            path = self.root / f"task-{task}"
            path.mkdir()
            (path / "task.toml").write_text('[environment]\ndocker_image="fixture"\n')

    def result(self, name: str) -> None:
        if self.missing_result and name == self.started[0]:
            return
        path = self.root / "jobs" / name / "trial" / "result.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        data: dict[str, object] = {"reward": 1}
        if self.fail_setup and name == self.started[0]:
            data = {
                "reward": None,
                "exception_info": {"exception_type": "AgentSetupTimeoutError"},
            }
        path.write_text(json.dumps(data))

    def launch(self, command: list[str], **kwargs: object) -> Mock:
        name = command[command.index("--job-name") + 1]
        self.started.append(name)
        rows = json.loads((self.root / "progress.json").read_text())
        active = [row for row in rows if row["state"] == "running"]
        self.assertEqual(len(active), len({row["task"] for row in active}))
        self.peak = max(self.peak, len(active))
        finish_at = self.tick + 2
        process = Mock()
        process.pid = len(self.started)
        process.returncode = None

        def finish(timeout: int = 0) -> int:
            self.result(name)
            process.returncode = 0
            return 0

        def poll() -> int | None:
            if self.tick >= finish_at:
                return finish()
            return process.returncode

        process.poll.side_effect = poll
        process.wait.side_effect = finish
        return process

    def advance(self, seconds: int) -> None:
        self.tick += 1
        if self.fail_setup:
            self.result(self.started[0])

    def summarize(self, path: Path) -> dict:
        result = json.loads(path.read_text())
        return {
            "reward": result["reward"],
            "exception": result.get("exception_info"),
        }

    def execute(self, concurrency: int = 2) -> list[dict]:
        with ExitStack() as stack:
            stack.enter_context(
                patch.dict(
                    os.environ,
                    {
                        "JEV_EVAL_AUTH_MODE": "subscription",
                        "TYPESAFE_API_KEY": "fixture-only",
                    },
                )
            )
            stack.enter_context(
                patch(
                    "evals.full.subprocess.check_output",
                    side_effect=[b"", "0.22.0", "fixture-commit"],
                )
            )
            stack.enter_context(
                patch("evals.full.subscription_mounts", return_value=[])
            )
            stack.enter_context(
                patch(
                    "evals.full.source_hashes",
                    side_effect=lambda: {
                        "src/test": "changed"
                        if self.change_sources and self.tick
                        else "same"
                    },
                )
            )
            stack.enter_context(
                patch("evals.full.shutil.disk_usage", return_value=Mock(free=10**12))
            )
            stack.enter_context(
                patch("evals.full.subprocess.Popen", side_effect=self.launch)
            )
            stack.enter_context(patch("evals.full.os.killpg"))
            stack.enter_context(
                patch("evals.full.time.sleep", side_effect=self.advance)
            )
            stack.enter_context(
                patch("evals.full.summarize_trial", side_effect=self.summarize)
            )
            run(self.root, self.root, "harbor", "modal", concurrency=concurrency)
        return json.loads((self.root / "progress.json").read_text())

    def test_concurrency_is_bounded_and_each_pair_keeps_its_order(self) -> None:
        rows = self.execute()
        self.assertEqual(self.peak, 2)
        self.assertEqual(len(self.started), 6)
        for task in range(3):
            self.assertLess(
                self.started.index(f"task-{task}-control"),
                self.started.index(f"task-{task}-plugin"),
            )
        self.assertTrue(all(row["state"] == "finished" for row in rows[:6]))
        self.assertTrue((self.root / "finished.json").exists())
        self.assertTrue(all(row["execution_concurrency"] == 2 for row in rows[:6]))

    def test_single_worker_preserves_manifest_order(self) -> None:
        self.execute(concurrency=1)
        self.assertEqual(self.peak, 1)
        self.assertEqual(self.started, [row["job_name"] for row in self.manifest[:6]])

    def test_setup_blocker_stops_launches_and_checkpoints_inflight_results(
        self,
    ) -> None:
        self.fail_setup = True
        rows = self.execute()
        self.assertEqual(len(self.started), 2)
        self.assertEqual(rows[0]["state"], "finished")
        self.assertEqual(rows[0]["failure_category"], "agent_setup")
        self.assertEqual(rows[2]["state"], "finished")
        self.assertEqual(sum(row["state"] == "pending" for row in rows), 4)
        self.assertFalse(any(row["state"] == "running" for row in rows))
        self.assertFalse((self.root / "finished.json").exists())

    def test_missing_harbor_result_stops_new_launches(self) -> None:
        self.missing_result = True
        rows = self.execute()
        self.assertEqual(len(self.started), 2)
        self.assertEqual(rows[0]["state"], "infrastructure_error")
        self.assertEqual(rows[2]["state"], "finished")
        self.assertTrue((self.root / "blocker.json").exists())

    def test_source_change_drains_existing_trials_without_new_launches(self) -> None:
        self.change_sources = True
        rows = self.execute()
        self.assertEqual(len(self.started), 2)
        self.assertFalse(any(row["state"] == "running" for row in rows))
        self.assertTrue((self.root / "blocker.json").exists())

    def test_nonpositive_concurrency_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "positive"):
            run(self.root, self.root, "harbor", concurrency=0)
