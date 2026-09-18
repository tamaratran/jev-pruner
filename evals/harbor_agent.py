"""Harbor 0.22.0 Claude Code adapter; task prompts and verifiers stay upstream."""

import json
import os
import shlex
from pathlib import Path

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext

CLAUDE_VERSION = "2.1.274"
REPO = Path(__file__).resolve().parents[1]
REMOTE = "/opt/jev-eval"


def arm() -> str:
    value = os.environ["JEV_EVAL_ARM"]
    if value not in {"control", "plugin"}:
        raise ValueError("JEV_EVAL_ARM must be control or plugin")
    return value


class JevClaudeCode(ClaudeCode):
    async def setup(self, environment: BaseEnvironment) -> None:
        if self._version != CLAUDE_VERSION:
            raise ValueError(f"Pass --ak version={CLAUDE_VERSION}")
        arm()
        await super().setup(environment)
        version = await self.exec_as_agent(
            environment, command=self.get_version_command() or "false"
        )
        if self.parse_version(version.stdout or "") != CLAUDE_VERSION:
            raise RuntimeError("Installed Claude version does not match pin")
        for directory in (".claude-plugin", "hooks", "src"):
            await environment.upload_dir(
                REPO / directory, f"{REMOTE}/production/{directory}"
            )
        await environment.upload_dir(REPO / "evals/observer", f"{REMOTE}/observer")
        (self.logs_dir / "eval-settings.json").write_text(
            json.dumps(
                {
                    "arm": arm(),
                    "claude_version": CLAUDE_VERSION,
                    "model": self.model_name,
                    "cli_flags": self.build_cli_flags(),
                },
                indent=2,
            )
        )

    def build_cli_flags(self) -> str:
        flags = super().build_cli_flags()
        flags += (
            f" --setting-sources '' --strict-mcp-config --plugin-dir {REMOTE}/observer"
        )
        flags += ' --settings \'{"enabledPlugins":{"plugin-authoring@builtin":false}}\''
        if arm() == "plugin":
            flags += f" --plugin-dir {REMOTE}/production"
        return flags

    def _resolve_auth_env(self) -> dict[str, str]:
        env = super()._resolve_auth_env()
        env["CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"] = "1"
        env["TYPESAFE_API_KEY"] = os.environ["TYPESAFE_API_KEY"]
        return env

    async def exec_as_agent(
        self,
        environment: BaseEnvironment,
        command: str,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ) -> ExecResult:
        effective_env = {
            **(env or {}),
            "DISABLE_TELEMETRY": "1",
            "DISABLE_ERROR_REPORTING": "1",
            "DISABLE_AUTOUPDATER": "1",
        }
        effective_env.pop("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", None)
        return await super().exec_as_agent(
            environment, command, env=effective_env, cwd=cwd, timeout_sec=timeout_sec
        )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await super().run(instruction, environment, context)
        path = (self.environment_logs_dir / "claude-code.txt").as_posix()
        result = await self.exec_as_agent(
            environment, command=f"cat {shlex.quote(path)}"
        )
        events = []
        loaded_plugins = None
        for line in (result.stdout or "").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict) and event.get("type") == "result":
                events.append(event)
            if isinstance(event, dict) and event.get("subtype") == "init":
                loaded_plugins = {plugin["name"] for plugin in event.get("plugins", [])}
        expected_plugins = {"jev-eval-observer"}
        if arm() == "plugin":
            expected_plugins.add("fast-jev-output")
        if loaded_plugins != expected_plugins:
            raise RuntimeError(f"Unexpected loaded plugins: {loaded_plugins}")
        if not events:
            raise RuntimeError("Claude produced no final result event")
        last = events[-1]
        if last.get("is_error") or last.get("subtype") != "success":
            raise RuntimeError(f"Claude final result: {last.get('subtype')}")
        activation = await self.exec_as_agent(
            environment, command="test -s /logs/agent/jev/activated.json"
        )
        if activation.return_code != 0:
            raise RuntimeError("Observer activation evidence missing")
