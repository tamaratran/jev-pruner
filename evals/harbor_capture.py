"""Capture unchanged shell streams while retaining native Codex trajectories."""

import json
import shlex

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment

from evals.harbor_codex import MODEL, REMOTE, REPO, VERSION, JevCodex

INSTRUCTIONS = """Run noninteractive terminal commands through this capture wrapper:
node /opt/jev-eval/evals/capture_command.mjs -- <executable> <arguments>
For compound commands use -- bash -c '...'; preserve quoting and working directory.
It returns stdout, stderr and exit status unchanged; pruning is disabled.
Use normal tools for editing files, viewing images and interactive commands.
Choose commands and verbosity naturally. Do not print extra data for measurement.
Do not inspect or modify /opt/jev-eval, /logs, /tests or private evaluation files.
Use only the task's source files as evidence; do not search online for benchmark
answers, solutions or grading code. Complete the task normally without delegation."""


class CaptureCodex(JevCodex):
    async def setup(self, environment: BaseEnvironment) -> None:
        if self._version != VERSION or self.model_name != MODEL:
            raise ValueError("Use the frozen Codex version and model")
        if self.config_source is not None:
            raise ValueError("Custom Codex configuration is not allowed")
        await Codex.setup(self, environment)
        version = await self.exec_as_agent(
            environment, command=self.get_version_command() or "false"
        )
        if self.parse_version(version.stdout or "") != VERSION:
            raise ValueError("Codex version mismatch")
        await environment.upload_file(
            REPO / "evals/capture_command.mjs", f"{REMOTE}/evals/capture_command.mjs"
        )
        await environment.upload_file(
            REPO / "evals/observer/evidence-isolation.mjs",
            f"{REMOTE}/evals/observer/evidence-isolation.mjs",
        )
        await self.exec_as_agent(
            environment, command=f"mkdir -p -m 700 {REMOTE}/evidence"
        )
        (self.logs_dir / "eval-settings.json").write_text(
            json.dumps(
                {
                    "mode": "capture-only",
                    "version": VERSION,
                    "model": MODEL,
                    "instructions": INSTRUCTIONS,
                    "flags": self.build_cli_flags(),
                    "pruning_enabled": False,
                },
                indent=2,
            )
        )

    def build_cli_flags(self) -> str:
        settings = {
            "forced_login_method": "chatgpt",
            "tool_output_token_limit": 10000,
            "developer_instructions": INSTRUCTIONS,
            "features.multi_agent": False,
        }
        return (
            Codex.build_cli_flags(self)
            + " "
            + " ".join(
                f"-c {shlex.quote(f'{key}={json.dumps(value)}')}"
                for key, value in settings.items()
            )
        )
