import asyncio
import json
import os
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, create_autospec, patch

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext

from evals.auth import AUTH_OVERRIDES, AUTH_RUNTIME, auth_mode, subscription_mounts
from evals.harbor_agent import JevClaudeCode


class AuthTests(unittest.TestCase):
    def test_mode_is_explicit_and_unknown_modes_fail(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(auth_mode(), "api")
        with (
            patch.dict(os.environ, {"JEV_EVAL_AUTH_MODE": "unknown"}, clear=True),
            self.assertRaises(ValueError),
        ):
            auth_mode()

    def test_private_mount_is_read_only_and_not_inside_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "auth"
            source.mkdir()
            with patch.dict(
                os.environ,
                {
                    "JEV_EVAL_CLAUDE_AUTH_DIR": str(source),
                    "EVIDENCE_DIR": str(root / "evidence"),
                },
            ):
                with self.assertRaises(ValueError):
                    subscription_mounts()
                (source / ".credentials.json").write_text("test fixture")
                mount = subscription_mounts()[0]
                self.assertTrue(mount["read_only"])
                self.assertFalse(mount["bind"]["create_host_path"])
                with (
                    patch.dict(os.environ, {"EVIDENCE_DIR": str(root)}),
                    self.assertRaises(ValueError),
                ):
                    subscription_mounts()

    def test_preflight_rejects_other_auth_sources_and_filters_account_data(
        self,
    ) -> None:
        script = Path(__file__).with_name("check_auth.cjs")
        with tempfile.TemporaryDirectory() as directory:
            claude = Path(directory) / "claude"
            claude.write_text(
                "#!/bin/sh\nprintf '%s' \"$FAKE_AUTH_STATUS\"\n"
                'exit "${FAKE_AUTH_EXIT:-0}"\n'
            )
            claude.chmod(0o700)
            base = {
                "loggedIn": True,
                "authMethod": "claude.ai",
                "apiProvider": "firstParty",
                "subscriptionType": "max",
                "email": "private@example.test",
                "accessToken": "must-not-appear",
            }
            cases = [
                (base, 0),
                ({**base, "authMethod": "api_key"}, 1),
                ({**base, "authMethod": "oauth_token"}, 1),
                ({**base, "apiProvider": "bedrock"}, 1),
                ({**base, "loggedIn": False}, 1),
                (None, 1),
                ("malformed", 1),
            ]
            for value, expected in cases:
                with self.subTest(value=value):
                    result = subprocess.run(
                        ["node", str(script)],
                        env={
                            **os.environ,
                            "PATH": f"{directory}:{os.environ['PATH']}",
                            "FAKE_AUTH_STATUS": json.dumps(value),
                        },
                        capture_output=True,
                        text=True,
                        check=False,
                    )
                    self.assertEqual(result.returncode, expected)
                    self.assertNotIn(
                        "private@example.test", result.stdout + result.stderr
                    )
                    self.assertNotIn("must-not-appear", result.stdout + result.stderr)
                    if not expected:
                        self.assertEqual(
                            set(json.loads(result.stdout)),
                            {
                                "loggedIn",
                                "authMethod",
                                "apiProvider",
                                "subscriptionType",
                            },
                        )


class AdapterAuthTests(unittest.IsolatedAsyncioTestCase):
    def test_plugin_options_reach_only_the_plugin_arm(self) -> None:
        for arm in ("control", "plugin"):
            with (
                tempfile.TemporaryDirectory() as directory,
                patch.dict(
                    os.environ,
                    {
                        "JEV_EVAL_AUTH_MODE": "subscription",
                        "JEV_EVAL_ARM": arm,
                        "JEV_EVAL_DIAGNOSTICS": "1",
                        "JEV_EVAL_CHUNK_CHARS": "4000",
                    },
                ),
                patch.object(ClaudeCode, "build_cli_flags", return_value=""),
            ):
                agent = JevClaudeCode(
                    logs_dir=Path(directory),
                    model_name="anthropic/claude-sonnet-5",
                )
                flags = shlex.split(agent.build_cli_flags())
                settings = json.loads(flags[flags.index("--settings") + 1])
                self.assertEqual(settings["forceLoginMethod"], "claudeai")
                if arm == "control":
                    self.assertNotIn("pluginConfigs", settings)
                else:
                    self.assertEqual(
                        settings["pluginConfigs"],
                        {
                            "fast-jev-output@inline": {
                                "options": {"diagnostics": True, "chunkChars": 4000}
                            },
                        },
                    )

    async def test_subscription_ignores_api_resolver_and_container_overrides(
        self,
    ) -> None:
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(
                os.environ,
                {
                    "JEV_EVAL_AUTH_MODE": "subscription",
                    "JEV_EVAL_ARM": "control",
                    "TYPESAFE_API_KEY": "fake-jev",
                    "ANTHROPIC_API_KEY": "fake-api",
                },
            ),
        ):
            agent = JevClaudeCode(
                logs_dir=Path(directory), model_name="anthropic/claude-sonnet-5"
            )
            with patch.object(ClaudeCode, "_resolve_auth_env") as resolver:
                self.assertNotIn("ANTHROPIC_API_KEY", agent._resolve_auth_env())
                resolver.assert_not_called()
            with patch.object(
                ClaudeCode,
                "exec_as_agent",
                new_callable=AsyncMock,
                return_value=ExecResult(stdout="", stderr="", return_code=0),
            ) as execute:
                await agent.exec_as_agent(
                    create_autospec(BaseEnvironment, instance=True),
                    command="env | sort",
                    env={
                        **dict.fromkeys(AUTH_OVERRIDES, "fake"),
                        "CLAUDE_CONFIG_DIR": "/logs",
                    },
                )
                call = execute.call_args
                self.assertEqual(call.kwargs["env"]["CLAUDE_CONFIG_DIR"], AUTH_RUNTIME)
                self.assertTrue(set(AUTH_OVERRIDES).isdisjoint(call.kwargs["env"]))
                result = await asyncio.to_thread(
                    subprocess.run,
                    ["bash", "-c", call.args[1]],
                    env={**os.environ, **dict.fromkeys(AUTH_OVERRIDES, "fake")},
                    capture_output=True,
                    text=True,
                    check=True,
                )
                for key in AUTH_OVERRIDES:
                    self.assertNotIn(f"{key}=", result.stdout)

    async def test_failed_preflight_prevents_inference(self) -> None:
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {"JEV_EVAL_AUTH_MODE": "subscription"}),
        ):
            agent = JevClaudeCode(
                logs_dir=Path(directory), model_name="anthropic/claude-sonnet-5"
            )
            with (
                patch.object(
                    agent,
                    "check_subscription",
                    new_callable=AsyncMock,
                    side_effect=RuntimeError("Not logged in"),
                ),
                patch.object(ClaudeCode, "run", new_callable=AsyncMock) as run,
            ):
                with self.assertRaises(RuntimeError):
                    await agent.run(
                        "Never run",
                        create_autospec(BaseEnvironment, instance=True),
                        AgentContext(),
                    )
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
