import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import AsyncMock, create_autospec, patch

from harbor.environments.base import BaseEnvironment, ExecResult

from evals.codex_bench import run
from evals.compilebench import REVISION, TASKS, plan
from evals.harbor_codex import MODEL, VERSION, JevCodex
from evals.standardized_codex import SETTINGS, StandardizedCodex


class StandardizedAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_setup_creates_fingerprintable_empty_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent = StandardizedCodex(
                logs_dir=Path(directory), model_name=MODEL, version=VERSION
            )
            remote = create_autospec(BaseEnvironment, instance=True)
            with (
                patch.object(JevCodex, "setup", new_callable=AsyncMock),
                patch.object(agent, "exec_as_agent", new_callable=AsyncMock),
                patch.object(
                    agent, "_upload_config_text", new_callable=AsyncMock
                ) as upload,
                patch.dict(os.environ, {"JEV_EVAL_MODEL_CATALOG": "models.json"}),
            ):
                await agent.setup(remote)
                upload.assert_awaited_once_with(
                    remote,
                    content="",
                    remote_path="/opt/jev-eval/codex-home/config.toml",
                    filename="config.toml",
                )

    async def test_both_arms_use_the_gate_with_identical_cli_flags(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent = StandardizedCodex(
                logs_dir=Path(directory), model_name=MODEL, version=VERSION
            )
            flags = []
            for arm in ("control", "plugin"):
                with patch.dict(os.environ, {"JEV_EVAL_ARM": arm}):
                    flags.append(agent.build_cli_flags())
            self.assertEqual(flags[0], flags[1])
            for name in SETTINGS:
                self.assertIn(name, flags[0])
            remote = create_autospec(BaseEnvironment, instance=True)
            with patch.object(
                JevCodex, "exec_as_agent", new_callable=AsyncMock
            ) as execute:
                execute.return_value = ExecResult(return_code=0)
                await agent.exec_as_agent(
                    remote,
                    "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; codex exec --model gpt-5.5",
                )
                self.assertIn("codex_gate.mjs -- codex exec", execute.call_args.args[1])
                await agent.exec_as_agent(remote, "codex --version")
                self.assertEqual(execute.call_args.args[1], "codex --version")


class StandardizedPlanTests(unittest.TestCase):
    def test_seeded_repetitions_are_reproducible_and_pin_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            benchmark, replay = root / "benchmark", root / "replay"
            for name in TASKS:
                folder = benchmark / "datasets/compilebench" / name
                folder.mkdir(parents=True)
                (folder / "task.toml").write_text('version = "1.0"\n')
            replay.mkdir()
            (replay / "protocol.json").write_text('{"source_sha256":{}}')
            (replay / "results.json").write_text("[]")
            (replay / "gate.json").write_text('{"passed":true,"replayed":4}')
            catalog = root / "catalog.json"
            catalog.write_text(
                '{"models":[{"slug":"gpt-5.5"},{"slug":"other"}],"etag":"volatile"}'
            )
            schedules = []
            with (
                patch(
                    "evals.compilebench.git",
                    side_effect=lambda _root, *args: (
                        REVISION if args == ("rev-parse", "HEAD") else ""
                    ),
                ),
                patch("evals.compilebench.source_hashes", return_value={}),
            ):
                for index, seed in enumerate(["seed", "seed", "different"]):
                    target = root / f"run-{index}"
                    plan(
                        target,
                        benchmark,
                        replay,
                        4,
                        repetitions=2,
                        seed=seed,
                        model_catalog=catalog,
                    )
                    rows = json.loads((target / "progress.json").read_text())
                    protocol = json.loads((target / "protocol.json").read_text())
                    self.assertEqual(len(rows), 16)
                    self.assertIn("StandardizedCodex", " ".join(protocol["flags"]))
                    self.assertEqual(
                        protocol["standardization"]["catalog_sha256"],
                        hashlib.sha256(
                            (target / "models.json").read_bytes()
                        ).hexdigest(),
                    )
                    self.assertEqual(
                        json.loads((target / "models.json").read_text()),
                        {"models": [{"slug": "gpt-5.5"}]},
                    )
                    for name in TASKS:
                        first = [row for row in rows if row["task"] == f"{name}-r1"]
                        second = [row for row in rows if row["task"] == f"{name}-r2"]
                        self.assertNotEqual(first[0]["arm"], second[0]["arm"])
                    schedules.append([(row["task"], row["arm"]) for row in rows])
            self.assertEqual(schedules[0], schedules[1])
            self.assertNotEqual(schedules[0], schedules[2])

    def test_runner_passes_reference_and_retains_rejections(self) -> None:
        for accepted in (True, False):
            with (
                self.subTest(accepted=accepted),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                rows = [
                    {"task": "task", "arm": arm, "state": "pending", "job_name": arm}
                    for arm in ("plugin", "control")
                ]
                (root / "models.json").write_text("{}")
                (root / "auth.json").write_text('{"auth_mode":"chatgpt"}')
                (root / "progress.json").write_text(json.dumps(rows))
                (root / "protocol.json").write_text(
                    json.dumps(
                        {
                            "selected_tasks": ["task"],
                            "concurrency": 1,
                            "flags": [
                                "-a",
                                "evals.standardized_codex:StandardizedCodex",
                            ],
                            "source_sha256": {},
                            "modal_image_builder_version": "2025.06",
                            "standardization": {
                                "catalog_sha256": hashlib.sha256(b"{}").hexdigest()
                            },
                        }
                    )
                )
                launches = []

                def launch(
                    command: list[str], *, env: dict[str, str], **_kwargs: object
                ) -> CompletedProcess:
                    arm = env["JEV_EVAL_ARM"]
                    launches.append(arm)
                    if arm == "plugin":
                        self.assertNotIn("JEV_EVAL_EXPECTED_START", env)
                    else:
                        self.assertEqual(
                            env["JEV_EVAL_EXPECTED_START"],
                            str(root / "jobs/plugin/task__trial/agent/start.json"),
                        )
                    trial = root / "jobs" / arm / "task__trial"
                    (trial / "agent").mkdir(parents=True)
                    (trial / "result.json").write_text("{}")
                    (trial / "agent/start.json").write_text(
                        json.dumps(
                            {
                                "status": "accepted" if accepted else "rejected",
                                "sha256": "fixture",
                            }
                        )
                    )
                    return CompletedProcess(command, 0)

                with (
                    patch("evals.codex_bench.git", return_value=""),
                    patch("evals.codex_bench.source_hashes", return_value={}),
                    patch(
                        "evals.codex_bench.subprocess.check_output",
                        return_value="0.22.0",
                    ),
                    patch("evals.codex_bench.subprocess.run", side_effect=launch),
                    patch.dict(
                        os.environ,
                        {
                            "TYPESAFE_API_KEY": "fixture-only",
                            "JEV_CODEX_AUTH_FILE": str(root / "auth.json"),
                            "JEV_EVAL_EXPECTED_START": "unrelated-inherited-reference",
                        },
                    ),
                ):
                    run(root, "harbor")
                result = json.loads((root / "progress.json").read_text())
                self.assertEqual(len(result), 2)
                self.assertEqual(
                    launches, ["plugin", "control"] if accepted else ["plugin"]
                )
                self.assertEqual(
                    [row["state"] for row in result],
                    ["finished", "finished"]
                    if accepted
                    else ["preflight_rejected", "blocked"],
                )
