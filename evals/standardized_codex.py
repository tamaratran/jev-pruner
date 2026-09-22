"""A pinned initial request and runtime, checked before forwarding inference."""

import json
import os
import shlex
from pathlib import Path, PurePosixPath

from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext

from evals.harbor_codex import REMOTE, REPO, JevCodex

SETTINGS: dict[str, str | int | bool] = {
    "model_reasoning_effort": "high",
    "web_search": "disabled",
    "model_catalog_json": f"{REMOTE}/private/models.json",
    "chatgpt_base_url": "http://127.0.0.1:49371",
    "model_provider": "jev_eval",
    "model_providers.jev_eval.name": "OpenAI",
    "model_providers.jev_eval.base_url": "http://127.0.0.1:49371/codex",
    "model_providers.jev_eval.wire_api": "responses",
    "model_providers.jev_eval.requires_openai_auth": True,
    "model_providers.jev_eval.supports_websockets": False,
    "features.plugins": False,
    "features.recommended_plugins": False,
    "features.remote_plugin": False,
    "features.apps": False,
    "features.memories": False,
    "features.multi_agent": False,
    "features.skip_host_skill_discovery": True,
    "features.enable_request_compression": False,
    "features.unbounded_connection_retries": False,
    "check_for_update_on_startup": False,
    "analytics.enabled": False,
    "feedback.enabled": False,
}


class StandardizedCodex(JevCodex):
    _REMOTE_CODEX_HOME = PurePosixPath(f"{REMOTE}/codex-home")
    _REMOTE_CODEX_SECRETS_DIR = PurePosixPath(f"{REMOTE}/codex-secrets")

    def build_cli_flags(self) -> str:
        return (
            super().build_cli_flags()
            + " "
            + " ".join(
                f"-c {shlex.quote(f'{key}={json.dumps(value)}')}"
                for key, value in SETTINGS.items()
            )
        )

    async def setup(self, environment: BaseEnvironment) -> None:
        if self._resume or self._load or self._build_register_skills_command():
            raise ValueError(
                "Standardized trials require a fresh session without skills"
            )
        await super().setup(environment)
        await self.exec_as_agent(
            environment, command=f"mkdir -p {self._REMOTE_CODEX_HOME}"
        )
        await self._upload_config_text(
            environment,
            content="",
            remote_path=str(self._REMOTE_CODEX_HOME / "config.toml"),
            filename="config.toml",
        )
        for name in ("codex_gate.mjs", "codex_start.mjs"):
            await environment.upload_file(
                REPO / "evals" / name, f"{REMOTE}/evals/{name}"
            )
        await environment.upload_file(
            Path(os.environ["JEV_EVAL_MODEL_CATALOG"]), f"{REMOTE}/private/models.json"
        )
        if os.environ.get("JEV_EVAL_EXPECTED_START"):
            await environment.upload_file(
                Path(os.environ["JEV_EVAL_EXPECTED_START"]),
                f"{REMOTE}/private/expected-start.json",
            )

    async def exec_as_agent(
        self,
        environment: BaseEnvironment,
        command: str,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ) -> ExecResult:
        if command.startswith("if [ -s ~/.nvm/nvm.sh ];") and "codex exec " in command:
            command = command.replace(
                "codex exec ", f"node {REMOTE}/evals/codex_gate.mjs -- codex exec ", 1
            )
        return await super().exec_as_agent(
            environment, command, env=env, cwd=cwd, timeout_sec=timeout_sec
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
            await environment.download_file(
                f"{REMOTE}/private/start.json", self.logs_dir / "start.json"
            )
