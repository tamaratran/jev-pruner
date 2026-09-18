import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, create_autospec, patch

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment, ExecResult

from evals.harbor_agent import CLAUDE_VERSION, JevClaudeCode


class SubscriptionSetupTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_install_can_create_config_after_private_preparation(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            login = root / "login"
            login.mkdir()
            (login / ".credentials.json").write_text("fake-credential")
            runtime = root / "runtime"
            logs = root / "logs"
            logs.mkdir()
            environment = create_autospec(BaseEnvironment, instance=True)

            async def install(_environment: BaseEnvironment) -> None:
                runtime.mkdir(exist_ok=True)
                (runtime / "backups").mkdir()

            async def execute(
                _environment: BaseEnvironment, command: str
            ) -> ExecResult:
                if command == agent.get_version_command():
                    return ExecResult(
                        stdout=f"{CLAUDE_VERSION} (Claude Code)",
                        stderr="",
                        return_code=0,
                    )
                result = subprocess.run(
                    ["bash", "-c", command], capture_output=True, text=True, check=True
                )
                return ExecResult(
                    stdout=result.stdout, stderr=result.stderr, return_code=0
                )

            with (
                patch.dict(
                    os.environ,
                    {
                        "JEV_EVAL_AUTH_MODE": "subscription",
                        "JEV_EVAL_ARM": "control",
                    },
                ),
                patch("evals.auth.AUTH_MOUNT", str(login)),
                patch("evals.auth.AUTH_RUNTIME", str(runtime)),
            ):
                agent = JevClaudeCode(
                    logs_dir=logs,
                    model_name="anthropic/claude-sonnet-5",
                    version=CLAUDE_VERSION,
                )
                with (
                    patch.object(agent, "environment_logs_dir", new=logs),
                    patch.object(ClaudeCode, "setup", side_effect=install),
                    patch.object(agent, "exec_as_agent", side_effect=execute),
                    patch.object(
                        agent,
                        "check_subscription",
                        new_callable=AsyncMock,
                        return_value={"loggedIn": True},
                    ),
                ):
                    await agent.setup(environment)

            self.assertEqual(
                (runtime / ".credentials.json").read_text(), "fake-credential"
            )
            self.assertEqual(runtime.stat().st_mode & 0o777, 0o700)
            self.assertEqual(
                (runtime / ".credentials.json").stat().st_mode & 0o777, 0o600
            )
            self.assertEqual(
                (runtime / "projects").resolve(), logs / "sessions/projects"
            )
            self.assertFalse((logs / ".credentials.json").exists())


if __name__ == "__main__":
    unittest.main()
