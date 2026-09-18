"""Harbor install-only setup and basic sandbox probes; never invokes agent.run."""

from harbor.environments.base import BaseEnvironment

from evals.harbor_agent import REPO, REMOTE, JevClaudeCode


class ModalPreflightAgent(JevClaudeCode):
    async def setup(self, environment: BaseEnvironment) -> None:
        await super().setup(environment)
        await environment.upload_file(
            REPO / "evals/modal_probe.cjs", f"{REMOTE}/modal_probe.cjs"
        )
        result = await self.exec_as_agent(
            environment,
            command=(
                f'export PATH="$HOME/.local/bin:$PATH"; node {REMOTE}/modal_probe.cjs '
                f"{environment.task_env_config.storage_mb}"
            ),
            timeout_sec=60,
        )
        if result.return_code:
            raise RuntimeError("Modal capability preflight failed")
