import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

from evals.codex_bench import run
from evals.compilebench import REVISION, TASKS, plan


class CompileBenchPlanTests(unittest.TestCase):
    def test_docker_pairs_share_one_worker_while_modal_runs_in_parallel(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tasks = ["windows", "windows2", "linux"]
            rows = [
                {
                    "task": task,
                    "arm": arm,
                    "job_name": f"{task}-{arm}",
                    "state": "pending",
                }
                for task in tasks
                for arm in ("control", "plugin")
            ]
            protocol = {
                "selected_tasks": tasks,
                "serial_tasks": tasks[:2],
                "flags": ["--env", "modal"],
                "task_flags": {task: ["--env", "docker"] for task in tasks[:2]},
                "source_sha256": {},
                "concurrency": 3,
                "modal_image_builder_version": "2025.06",
            }
            (root / "progress.json").write_text(json.dumps(rows))
            (root / "protocol.json").write_text(json.dumps(protocol))
            (root / "auth.json").write_text('{"auth_mode":"chatgpt"}')
            guard = threading.Lock()
            local_started, modal_started = threading.Event(), threading.Event()
            active_local: set[str] = set()
            local_order = []

            def launch(command: list[str], **_kwargs: object) -> CompletedProcess:
                name = command[command.index("--job-name") + 1]
                environment = command[command.index("--env") + 1]
                if environment == "docker":
                    with guard:
                        self.assertFalse(active_local)
                        active_local.add(name)
                        local_order.append(name)
                    local_started.set()
                    self.assertTrue(modal_started.wait(5))
                else:
                    self.assertTrue(local_started.wait(5))
                    modal_started.set()
                trial = root / "jobs" / name / "trial"
                trial.mkdir(parents=True)
                (trial / "result.json").write_text("{}")
                if environment == "docker":
                    with guard:
                        active_local.remove(name)
                return CompletedProcess(command, 0)

            with (
                patch("evals.codex_bench.git", return_value=""),
                patch("evals.codex_bench.source_hashes", return_value={}),
                patch(
                    "evals.codex_bench.subprocess.check_output", return_value="0.22.0"
                ),
                patch("evals.codex_bench.subprocess.run", side_effect=launch),
                patch.dict(
                    os.environ,
                    {
                        "TYPESAFE_API_KEY": "fixture-only",
                        "JEV_CODEX_AUTH_FILE": str(root / "auth.json"),
                    },
                ),
            ):
                run(root, "harbor")
                with self.assertRaisesRegex(ValueError, "silently retried"):
                    run(root, "harbor")
            self.assertEqual(len(local_order), 4)
            first = local_order[0].removesuffix("-control")
            second = (set(tasks[:2]) - {first}).pop()
            self.assertEqual(
                local_order,
                [
                    f"{task}-{arm}"
                    for task in (first, second)
                    for arm in ("control", "plugin")
                ],
            )
            self.assertTrue(
                all(
                    row["state"] == "finished"
                    for row in json.loads((root / "progress.json").read_text())
                )
            )

    def test_full_suite_includes_every_task_and_pins_docker_pairs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            benchmark, replay = root / "benchmark", root / "replay"
            names = (
                *TASKS,
                "jq-windows",
                "jq-windows2",
                *(f"build-{i}" for i in range(9)),
            )
            for name in names:
                folder = benchmark / "datasets/compilebench" / name
                folder.mkdir(parents=True)
                (folder / "task.toml").write_text('version = "1.0"\n')
                (folder / "test.sh").write_text(f"verify-{name}\n")
            replay.mkdir()
            (replay / "protocol.json").write_text('{"source_sha256":{}}')
            (replay / "results.json").write_text("[]")
            (replay / "gate.json").write_text('{"passed":true,"replayed":4}')

            def git_result(_root: Path, *args: str) -> str:
                return REVISION if args == ("rev-parse", "HEAD") else ""

            with (
                patch("evals.compilebench.git", side_effect=git_result),
                patch("evals.compilebench.source_hashes", return_value={}),
            ):
                with self.assertRaisesRegex(ValueError, "Docker tasks"):
                    plan(
                        root / "invalid",
                        benchmark,
                        replay,
                        15,
                        full=True,
                        docker_tasks=("missing",),
                    )
                plan(
                    root / "run",
                    benchmark,
                    replay,
                    15,
                    full=True,
                    docker_tasks=("jq-windows", "jq-windows2"),
                )
                (benchmark / "datasets/compilebench/jq/task.toml").unlink()
                with self.assertRaisesRegex(ValueError, "all 15 tasks"):
                    plan(root / "incomplete", benchmark, replay, 15, full=True)

            protocol = json.loads((root / "run/protocol.json").read_text())
            rows = json.loads((root / "run/progress.json").read_text())
            self.assertEqual(set(protocol["distinct_tasks"]), set(names))
            self.assertEqual(len(rows), 30)
            self.assertEqual(len({row["job_name"] for row in rows}), 30)
            self.assertEqual(protocol["repetitions"], 1)
            self.assertEqual(
                set(protocol["serial_tasks"]), {"jq-windows-r1", "jq-windows2-r1"}
            )
            for name in names:
                task = f"{name}-r1"
                pair = [row for row in rows if row["task"] == task]
                self.assertEqual({row["arm"] for row in pair}, {"control", "plugin"})
                self.assertEqual(
                    (root / "run/tasks" / task / "test.sh").read_text(),
                    f"verify-{name}\n",
                )
                flags = protocol["task_flags"].get(task, protocol["flags"])
                self.assertEqual(
                    flags[flags.index("--env") + 1],
                    "docker" if "windows" in name else "modal",
                )

    def test_pairs_copy_verifiers_and_reverse_order_between_repetitions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            benchmark, replay = root / "benchmark", root / "replay"
            for name in TASKS:
                folder = benchmark / "datasets" / "compilebench" / name
                folder.mkdir(parents=True)
                (folder / "test.sh").write_text(f"verify-{name}\n")
            replay.mkdir()
            (replay / "protocol.json").write_text('{"source_sha256":{}}')
            (replay / "results.json").write_text("[]")
            gate = replay / "gate.json"
            gate.write_text('{"passed":false,"replayed":4}')

            def git_result(_root: Path, *args: str) -> str:
                return REVISION if args == ("rev-parse", "HEAD") else ""

            with (
                patch("evals.compilebench.git", side_effect=git_result),
                patch("evals.compilebench.source_hashes", return_value={}),
            ):
                with self.assertRaisesRegex(ValueError, "passing four-output"):
                    plan(root / "run", benchmark, replay, 4)
                gate.write_text('{"passed":true,"replayed":4}')
                plan(root / "run", benchmark, replay, 4)
            rows = json.loads((root / "run/progress.json").read_text())
            self.assertEqual(len({row["job_name"] for row in rows}), 24)
            for name in TASKS:
                previous = None
                for repetition in range(1, 4):
                    task = f"{name}-r{repetition}"
                    pair = [row for row in rows if row["task"] == task]
                    self.assertEqual(
                        {row["arm"] for row in pair}, {"control", "plugin"}
                    )
                    if previous is not None:
                        self.assertNotEqual(pair[0]["arm"], previous)
                    previous = pair[0]["arm"]
                    self.assertEqual(
                        (root / "run/tasks" / task / "test.sh").read_text(),
                        f"verify-{name}\n",
                    )


if __name__ == "__main__":
    unittest.main()
