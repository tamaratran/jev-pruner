import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, create_autospec, patch

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext

from evals.harbor_agent import JevClaudeCode
from evals.modal_runner import trial_config


class RemoteDeadlineTests(unittest.IsolatedAsyncioTestCase):
    def test_manifest_agent_limit_reaches_both_arms(self):
        for arm in ("control", "plugin"):
            config = trial_config(
                Path("/unused"),
                Path("/benchmark"),
                {"task": "fixture", "arm": arm, "job_name": f"fixture-{arm}"},
                {"agent_seconds": 900, "full_lifetime_seconds": 2970},
                {},
                approved=False,
            )
            self.assertEqual(config.agent.kwargs["remote_timeout_seconds"], 900)

    async def test_deadline_covers_all_agent_commands_and_is_cleared_on_failure(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {"JEV_EVAL_AUTH_MODE": "subscription"}),
        ):
            agent = JevClaudeCode(
                logs_dir=Path(directory),
                model_name="anthropic/claude-sonnet-5",
                remote_timeout_seconds=900,
            )
            environment = create_autospec(BaseEnvironment, instance=True)

            async def run_measured(*args):
                await agent.exec_as_agent(environment, "first")
                await agent.exec_as_agent(environment, "second", timeout_sec=5)
                await agent.exec_as_agent(environment, "expired")

            with (
                patch.object(agent, "_run_measured", side_effect=run_measured),
                patch(
                    "evals.harbor_agent.monotonic", side_effect=[100, 103, 110, 1001]
                ),
                patch.object(
                    ClaudeCode,
                    "exec_as_agent",
                    new_callable=AsyncMock,
                    return_value=ExecResult(return_code=0),
                ) as execute,
            ):
                with self.assertRaisesRegex(TimeoutError, "deadline"):
                    await agent.run("task", environment, AgentContext())
                first, second = execute.call_args_list
                self.assertIn(
                    "timeout --signal=KILL 897.0s bash -o pipefail -c first",
                    first.args[1],
                )
                self.assertIn(
                    "timeout --signal=KILL 5.0s bash -o pipefail -c second",
                    second.args[1],
                )
                self.assertEqual(first.kwargs["timeout_sec"], 902)
                self.assertEqual(second.kwargs["timeout_sec"], 10)
                self.assertEqual(execute.await_count, 2)
                self.assertIsNone(agent.remote_deadline)
