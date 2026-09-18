import asyncio
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path, PurePosixPath
from unittest.mock import AsyncMock, create_autospec, patch

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment, ExecResult

from evals.harbor_agent import JevClaudeCode


class CloudSubscriptionTests(unittest.IsolatedAsyncioTestCase):
    async def test_upload_is_private_allowlisted_and_precedes_install(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            for name in (".credentials.json", ".claude.json", "unwanted-history"):
                (source / name).write_text(f"fixture-{name}")
            staging, runtime, logs = root / "login", root / "runtime", root / "logs"
            logs.mkdir()
            environment = create_autospec(BaseEnvironment, instance=True)
            environment.capabilities.mounted = False
            credential_uploads = []

            async def upload(source_path: Path, target_path: str) -> None:
                if target_path.startswith(str(staging)):
                    self.assertEqual(stat.S_IMODE(staging.stat().st_mode), 0o700)
                    shutil.copyfile(source_path, target_path)
                    credential_uploads.append(Path(target_path).name)

            async def execute(env: BaseEnvironment, command: str) -> ExecResult:
                if "claude --version" in command:
                    return ExecResult(stdout="2.1.274 (Claude Code)", return_code=0)
                result = await asyncio.to_thread(
                    subprocess.run,
                    ["bash", "-c", command],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                return ExecResult(
                    stdout=result.stdout,
                    stderr=result.stderr,
                    return_code=result.returncode,
                )

            async def install(env: BaseEnvironment) -> None:
                for location in (staging, runtime):
                    self.assertEqual(stat.S_IMODE(location.stat().st_mode), 0o700)
                    for name in (".credentials.json", ".claude.json"):
                        self.assertEqual(
                            (location / name).read_text(), f"fixture-{name}"
                        )
                        self.assertEqual(
                            stat.S_IMODE((location / name).stat().st_mode), 0o600
                        )
                    self.assertFalse((location / "unwanted-history").exists())

            environment.upload_file.side_effect = upload
            with (
                patch.dict(
                    os.environ,
                    {
                        "JEV_EVAL_AUTH_MODE": "subscription",
                        "JEV_EVAL_ARM": "control",
                        "JEV_EVAL_CLAUDE_AUTH_DIR": str(source),
                        "EVIDENCE_DIR": str(logs),
                    },
                ),
                patch("evals.auth.AUTH_MOUNT", str(staging)),
                patch("evals.harbor_agent.AUTH_MOUNT", str(staging)),
                patch("evals.auth.AUTH_RUNTIME", str(runtime)),
                patch.object(ClaudeCode, "setup", side_effect=install) as installer,
                patch.object(JevClaudeCode, "exec_as_agent", side_effect=execute),
                patch.object(
                    JevClaudeCode,
                    "check_subscription",
                    new_callable=AsyncMock,
                    return_value={"loggedIn": True, "authMethod": "claude.ai"},
                ),
            ):
                agent = JevClaudeCode(
                    logs_dir=logs,
                    environment_logs_dir=PurePosixPath(logs),
                    model_name="anthropic/claude-sonnet-5",
                    version="2.1.274",
                )
                await agent.setup(environment)
                installer.assert_awaited_once()
                self.assertEqual(
                    credential_uploads, [".credentials.json", ".claude.json"]
                )
                self.assertEqual(list(logs.rglob(".credentials.json")), [])
                self.assertTrue((runtime / "projects").is_symlink())
                with self.assertRaisesRegex(RuntimeError, "staging directory"):
                    await agent.setup(environment)
                self.assertEqual(installer.await_count, 1)

    async def test_upload_failure_prevents_install(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / ".credentials.json").write_text("fixture")
            environment = create_autospec(BaseEnvironment, instance=True)
            environment.capabilities.mounted = False
            environment.upload_file.side_effect = RuntimeError("Transfer failed")
            with (
                patch.dict(
                    os.environ,
                    {
                        "JEV_EVAL_AUTH_MODE": "subscription",
                        "JEV_EVAL_ARM": "control",
                        "JEV_EVAL_CLAUDE_AUTH_DIR": str(source),
                        "EVIDENCE_DIR": str(source / "logs"),
                    },
                ),
                patch.object(ClaudeCode, "setup", new_callable=AsyncMock) as installer,
                patch.object(
                    JevClaudeCode,
                    "exec_as_agent",
                    new_callable=AsyncMock,
                    return_value=ExecResult(return_code=0),
                ),
            ):
                agent = JevClaudeCode(
                    logs_dir=source / "logs",
                    model_name="anthropic/claude-sonnet-5",
                    version="2.1.274",
                )
                with self.assertRaisesRegex(RuntimeError, "Transfer failed"):
                    await agent.setup(environment)
                installer.assert_not_awaited()
