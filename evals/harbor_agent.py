"""Harbor 0.22.0 Claude Code adapter; task prompts and verifiers stay upstream."""

import hashlib
import json
import os
import shlex
from pathlib import Path

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext

from evals.auth import (
    AUTH_MOUNT,
    AUTH_OVERRIDES,
    AUTH_RUNTIME,
    auth_mode,
    prepare_subscription,
    subscription_mounts,
)
from evals.sources import PRODUCTION, plugin_options, production_root

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
        auth_mode()
        if auth_mode() == "subscription" and self.config_source is not None:
            raise ValueError("Subscription evaluation does not accept custom settings")
        if auth_mode() == "subscription":
            if not environment.capabilities.mounted:
                await self.upload_subscription(environment)
            prepared = await self.exec_as_agent(
                environment,
                command=prepare_subscription(self.environment_logs_dir.as_posix()),
            )
            if prepared.return_code != 0:
                raise RuntimeError(
                    "Could not prepare private subscription configuration"
                )
        await super().setup(environment)
        version = await self.exec_as_agent(
            environment, command=self.get_version_command() or "false"
        )
        if self.parse_version(version.stdout or "") != CLAUDE_VERSION:
            raise RuntimeError("Installed Claude version does not match pin")
        for directory in PRODUCTION:
            await environment.upload_dir(
                production_root(REPO) / directory, f"{REMOTE}/production/{directory}"
            )
        await environment.upload_dir(REPO / "evals/observer", f"{REMOTE}/observer")
        await environment.upload_file(
            REPO / "evals/check_auth.cjs", f"{REMOTE}/check_auth.cjs"
        )
        auth_status = None
        if auth_mode() == "subscription":
            auth_status = await self.check_subscription(environment)
        (self.logs_dir / "eval-settings.json").write_text(
            json.dumps(
                {
                    "arm": arm(),
                    "claude_version": CLAUDE_VERSION,
                    "model": self.model_name,
                    "cli_flags": self.build_cli_flags(),
                    "auth_mode": auth_mode(),
                    "auth_status": auth_status,
                },
                indent=2,
            )
        )

    async def ensure_system_dependencies(
        self, environment: BaseEnvironment, dependencies: tuple[str, ...]
    ) -> None:
        if not dependencies:
            return
        if not await self.seed_apt_cache(environment):
            await super().ensure_system_dependencies(environment, dependencies)
            return
        packages = dict.fromkeys(
            package
            for dependency in dependencies
            for package in self.SYSTEM_PACKAGES[dependency].packages["apt-get"]
        )
        await self.exec_as_root(
            environment,
            command=f"apt-get install -y {shlex.join(packages)}",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

    async def seed_apt_cache(self, environment: BaseEnvironment) -> bool:
        directory = os.environ.get("JEV_EVAL_APT_CACHE_DIR")
        if not directory:
            return False
        source = Path(directory)
        manifest = json.loads((source / "manifest.json").read_text())
        distribution = f"{manifest['distribution']}:{manifest['codename']}"
        matches = await environment.exec(
            command=(
                ". /etc/os-release && "
                f'test "$ID:$VERSION_CODENAME" = {shlex.quote(distribution)} && '
                "test -d /var/cache/apt/archives"
            ),
            user="root",
        )
        if matches.return_code != 0:
            return False
        await self.exec_as_root(environment, command="apt-get update")
        for package in manifest["packages"]:
            name = package["filename"]
            if Path(name).name != name or not name.endswith(".deb"):
                raise ValueError("Invalid cached package filename")
            path = source / name
            if (
                path.is_symlink()
                or hashlib.sha256(path.read_bytes()).hexdigest() != package["sha256"]
            ):
                raise ValueError("Cached package checksum mismatch")
            await environment.upload_file(path, f"/var/cache/apt/archives/{name}")
        (self.logs_dir / "apt-cache-manifest.json").write_text(
            json.dumps(manifest, indent=2)
        )
        return True

    async def upload_subscription(self, environment: BaseEnvironment) -> None:
        source = Path(subscription_mounts()[0]["source"])
        created = await environment.exec(
            command=f"test ! -e {AUTH_MOUNT} && mkdir -p -m 700 {AUTH_MOUNT}"
        )
        if created.return_code != 0:
            raise RuntimeError("Could not create private remote login directory")
        for name in (".credentials.json", ".claude.json"):
            if (source / name).is_file():
                await environment.upload_file(source / name, f"{AUTH_MOUNT}/{name}")
        secured = await environment.exec(
            command=f"chmod 400 {AUTH_MOUNT}/.*json && chmod 500 {AUTH_MOUNT}"
        )
        if secured.return_code != 0:
            raise RuntimeError("Could not secure remote subscription configuration")

    def build_cli_flags(self) -> str:
        flags = super().build_cli_flags()
        flags += (
            f" --setting-sources '' --strict-mcp-config --plugin-dir {REMOTE}/observer"
        )
        settings: dict = {"enabledPlugins": {"plugin-authoring@builtin": False}}
        if auth_mode() == "subscription":
            settings["forceLoginMethod"] = "claudeai"
        if arm() == "plugin" and plugin_options():
            settings["pluginConfigs"] = {
                "fast-jev-output@inline": {"options": plugin_options()}
            }
        flags += f" --settings {shlex.quote(json.dumps(settings))}"
        if arm() == "plugin":
            flags += f" --plugin-dir {REMOTE}/production"
        return flags

    def _resolve_auth_env(self) -> dict[str, str]:
        env = {} if auth_mode() == "subscription" else super()._resolve_auth_env()
        env["CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"] = "1"
        env["TYPESAFE_API_KEY"] = os.environ["TYPESAFE_API_KEY"]
        return env

    def _resolved_model_name(self) -> str | None:
        if auth_mode() == "subscription":
            if not self.model_name or not self.model_name.startswith("anthropic/"):
                raise ValueError("Subscription mode requires an anthropic/ model")
            return self.model_name.split("/", 1)[1]
        return super()._resolved_model_name()

    async def check_subscription(self, environment: BaseEnvironment) -> dict:
        result = await self.exec_as_agent(
            environment,
            command=f'export PATH="$HOME/.local/bin:$PATH"; node {REMOTE}/check_auth.cjs',
        )
        if result.return_code != 0:
            raise RuntimeError("Subscription authentication preflight failed")
        return json.loads(result.stdout or "{}")

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
        if auth_mode() == "subscription":
            for key in AUTH_OVERRIDES:
                effective_env.pop(key, None)
            effective_env["CLAUDE_CONFIG_DIR"] = AUTH_RUNTIME
            command = f"unset {' '.join(AUTH_OVERRIDES)}; {command}"
        return await super().exec_as_agent(
            environment, command, env=effective_env, cwd=cwd, timeout_sec=timeout_sec
        )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if auth_mode() == "subscription":
            await self.check_subscription(environment)
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
