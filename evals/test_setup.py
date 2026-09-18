import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path, PurePosixPath
from unittest.mock import AsyncMock, create_autospec, patch

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment, ExecResult

from evals.harbor_agent import JevClaudeCode


class SubscriptionSetupTests(unittest.IsolatedAsyncioTestCase):
    async def test_installer_can_create_config_without_breaking_private_setup(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mount = root / "login"
            mount.mkdir()
            (mount / ".credentials.json").write_text("fixture")
            runtime = root / "runtime"
            logs = root / "logs"
            logs.mkdir()

            async def install(environment: BaseEnvironment) -> None:
                runtime.mkdir(exist_ok=True)
                (runtime / "install-marker").touch()

            async def execute(environment: BaseEnvironment, command: str) -> ExecResult:
                if "claude --version" in command:
                    return ExecResult(
                        stdout="2.1.274 (Claude Code)", stderr="", return_code=0
                    )
                result = subprocess.run(
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

            with (
                patch.dict(
                    os.environ,
                    {"JEV_EVAL_AUTH_MODE": "subscription", "JEV_EVAL_ARM": "control"},
                ),
                patch("evals.auth.AUTH_MOUNT", str(mount)),
                patch("evals.auth.AUTH_RUNTIME", str(runtime)),
                patch.object(ClaudeCode, "setup", side_effect=install),
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
                await agent.setup(create_autospec(BaseEnvironment, instance=True))

            self.assertTrue((runtime / "install-marker").exists())
            self.assertEqual((runtime / ".credentials.json").read_text(), "fixture")
            self.assertEqual(stat.S_IMODE(runtime.stat().st_mode), 0o700)
            self.assertEqual(
                stat.S_IMODE((runtime / ".credentials.json").stat().st_mode), 0o600
            )
            self.assertTrue((runtime / "projects").is_symlink())
            self.assertEqual(list(logs.rglob(".credentials.json")), [])


if __name__ == "__main__":
    unittest.main()
