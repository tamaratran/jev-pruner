import hashlib
import json
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
    async def test_cache_is_only_seeded_for_matching_distribution_and_valid_hash(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "fixture_1_amd64.deb"
            package.write_bytes(b"package fixture")
            manifest = {
                "distribution": "debian",
                "codename": "bullseye",
                "packages": [
                    {
                        "filename": package.name,
                        "sha256": hashlib.sha256(package.read_bytes()).hexdigest(),
                    }
                ],
            }
            (root / "manifest.json").write_text(json.dumps(manifest))
            logs = root / "logs"
            logs.mkdir()
            remote = create_autospec(BaseEnvironment, instance=True)
            agent = JevClaudeCode(logs_dir=logs, version="2.1.274")
            with patch.dict(os.environ, {"JEV_EVAL_APT_CACHE_DIR": str(root)}):
                remote.exec.return_value = ExecResult(return_code=1)
                await agent.seed_apt_cache(remote)
                remote.upload_file.assert_not_awaited()
                remote.exec.return_value = ExecResult(return_code=0)
                package.write_bytes(b"corrupted")
                with self.assertRaisesRegex(ValueError, "checksum"):
                    await agent.seed_apt_cache(remote)
                remote.upload_file.assert_not_awaited()
                package.write_bytes(b"package fixture")
                await agent.ensure_system_dependencies(remote, ("curl",))
                remote.upload_file.assert_awaited_once_with(
                    package, f"/var/cache/apt/archives/{package.name}"
                )
                self.assertEqual(
                    json.loads((logs / "apt-cache-manifest.json").read_text()), manifest
                )
                commands = [
                    call.kwargs["command"] for call in remote.exec.await_args_list
                ]
                self.assertEqual(
                    commands[-2:],
                    [
                        "set -o pipefail; apt-get update",
                        "set -o pipefail; apt-get install -y curl",
                    ],
                )
                calls = remote.mock_calls
                upload_index = next(
                    index
                    for index, call in enumerate(calls)
                    if call[0] == "upload_file"
                )
                self.assertEqual(
                    calls[upload_index - 1].kwargs["command"],
                    "set -o pipefail; apt-get update",
                )
                self.assertEqual(
                    calls[upload_index + 1].kwargs["command"],
                    "set -o pipefail; apt-get install -y curl",
                )

    async def test_cache_rejects_paths_outside_the_cache(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = {
                "distribution": "debian",
                "codename": "bullseye",
                "packages": [{"filename": "../private.deb", "sha256": "unused"}],
            }
            (root / "manifest.json").write_text(json.dumps(manifest))
            remote = create_autospec(BaseEnvironment, instance=True)
            remote.exec.return_value = ExecResult(return_code=0)
            agent = JevClaudeCode(logs_dir=root, version="2.1.274")
            with patch.dict(os.environ, {"JEV_EVAL_APT_CACHE_DIR": str(root)}):
                with self.assertRaisesRegex(ValueError, "filename"):
                    await agent.seed_apt_cache(remote)
            remote.upload_file.assert_not_awaited()

    async def test_remote_upload_only_stages_auth_files_outside_logs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "login"
            source.mkdir()
            for name in (".credentials.json", ".claude.json", "unrelated-secret"):
                (source / name).write_text("fixture")
            logs = root / "logs"
            logs.mkdir()
            remote = create_autospec(BaseEnvironment, instance=True)
            remote.exec.return_value = ExecResult(return_code=0)
            with patch(
                "evals.harbor_agent.subscription_mounts",
                return_value=[{"source": str(source)}],
            ):
                agent = JevClaudeCode(logs_dir=logs, version="2.1.274")
                await agent.upload_subscription(remote)
            self.assertEqual(remote.upload_file.await_count, 2)
            for name in (".credentials.json", ".claude.json"):
                remote.upload_file.assert_any_await(
                    source / name, f"/opt/jev-eval/login/{name}"
                )
            self.assertEqual(list(logs.rglob("*")), [])
            remote.exec.assert_awaited_with(
                command="chmod 400 /opt/jev-eval/login/.*json && chmod 500 /opt/jev-eval/login"
            )

    async def test_remote_upload_fails_before_copy_if_private_directory_fails(
        self,
    ) -> None:
        remote = create_autospec(BaseEnvironment, instance=True)
        remote.exec.return_value = ExecResult(return_code=1)
        with (
            tempfile.TemporaryDirectory() as directory,
            patch(
                "evals.harbor_agent.subscription_mounts",
                return_value=[{"source": directory}],
            ),
        ):
            agent = JevClaudeCode(logs_dir=Path(directory), version="2.1.274")
            with self.assertRaisesRegex(RuntimeError, "private remote"):
                await agent.upload_subscription(remote)
        remote.upload_file.assert_not_awaited()

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
