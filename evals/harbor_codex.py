"""Pinned Codex with identical command instrumentation in both benchmark arms."""

import json
import os
import shlex
from pathlib import Path

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext

from evals.harbor_agent import arm

REPO = Path(__file__).resolve().parents[1]
REMOTE = "/opt/jev-eval"
VERSION = "0.152.1"
MODEL = "openai/gpt-5.5"
INSTRUCTIONS = """For noninteractive build, test, installation and search commands
that may produce lengthy human-readable output, invoke the command through:
node /opt/jev-eval/evals/codex_command.mjs -- <executable> <arguments>
For a compound shell command, use -- bash -c '...'. Preserve quoting and workdir.
Use ordinary shell commands for interactive tools, servers, file reads, diffs,
machine-readable output and commands involving secrets.
The adapter preserves exit status and stderr and may shorten repetitive stdout.
Read the full-output archive in an omission footer if more information is needed.
Do not inspect or modify the adapter, its private files, or evaluation logs.
Complete the task normally. Do not delegate to other agents."""
OVERRIDES = (
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT_ID",
    "AZURE_OPENAI_API_KEY",
)


class JevCodex(Codex):
    async def setup(self, environment: BaseEnvironment) -> None:
        if self._version != VERSION or self.model_name != MODEL:
            raise ValueError("Use the frozen Codex version and model")
        if self.config_source is not None:
            raise ValueError("Custom Codex configuration is not allowed")
        arm()
        await super().setup(environment)
        version = await self.exec_as_agent(
            environment, command=self.get_version_command() or "false"
        )
        if self.parse_version(version.stdout or "") != VERSION:
            raise ValueError("Codex version mismatch")
        await environment.upload_dir(REPO / "dist", f"{REMOTE}/dist")
        for name in ("codex_command.mjs", "codex_observer.mjs"):
            await environment.upload_file(
                REPO / "evals" / name, f"{REMOTE}/evals/{name}"
            )
        await environment.upload_file(
            REPO / "evals/observer/evidence-isolation.mjs",
            f"{REMOTE}/evals/observer/evidence-isolation.mjs",
        )
        await self.exec_as_agent(
            environment,
            command=f"mkdir -p -m 700 {REMOTE}/private {REMOTE}/evidence",
        )
        await self._upload_config_text(
            environment,
            content=os.environ["TYPESAFE_API_KEY"],
            remote_path=f"{REMOTE}/private/jev-key",
            filename="jev-key",
        )
        await self.exec_as_agent(
            environment, command=f"chmod 600 {REMOTE}/private/jev-key"
        )
        (self.logs_dir / "eval-settings.json").write_text(
            json.dumps(
                {
                    "arm": arm(),
                    "version": VERSION,
                    "model": MODEL,
                    "instructions": INSTRUCTIONS,
                    "flags": self.build_cli_flags(),
                    "integration": "opt-in native command wrapper",
                },
                indent=2,
            )
        )

    def _resolve_auth_json_path(self) -> Path:
        path = Path(os.environ["JEV_CODEX_AUTH_FILE"])
        auth = json.loads(path.read_text())
        if auth.get("auth_mode") != "chatgpt" or auth.get("OPENAI_API_KEY"):
            raise ValueError("A ChatGPT login is required; no API fallback")
        return path

    def build_cli_flags(self) -> str:
        settings = {
            "forced_login_method": "chatgpt",
            "tool_output_token_limit": 10000,
            "developer_instructions": INSTRUCTIONS,
            "features.multi_agent": False,
        }
        return (
            super().build_cli_flags()
            + " "
            + " ".join(
                f"-c {shlex.quote(f'{key}={json.dumps(value)}')}"
                for key, value in settings.items()
            )
        )

    async def exec_as_agent(
        self,
        environment: BaseEnvironment,
        command: str,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ) -> ExecResult:
        effective = {
            key: value for key, value in (env or {}).items() if key not in OVERRIDES
        }
        effective["JEV_EVAL_ARM"] = arm()
        return await super().exec_as_agent(
            environment,
            f"unset {' '.join(OVERRIDES)}; {command}",
            env=effective,
            cwd=cwd,
            timeout_sec=timeout_sec,
        )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        try:
            await super().run(instruction, environment, context)
        finally:
            await environment.download_dir(
                f"{REMOTE}/evidence", self.logs_dir / "observer"
            )
            await self.exec_as_agent(
                environment, command=f"rm -f {REMOTE}/private/jev-key"
            )
