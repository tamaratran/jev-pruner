"""Pinned Harbor Modal execution with checked evidence before bounded teardown."""

import asyncio
import hashlib
import json
import os
import shlex
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

from harbor.environments.base import ExecResult
from harbor.environments.modal import ModalEnvironment
from modal import App, Image, Sandbox, Secret

from evals.full import save
from evals.registry_auth import registry_credentials

TRANSFER_SECONDS = 300
CLEANUP_SECONDS = 90


def verify_downloads(root: Path, manifest: str) -> dict[str, str]:
    verified = {}
    for entry in manifest.split("\0"):
        if not entry:
            continue
        digest, remote = entry.split("  ", 1)
        relative = Path(remote).relative_to("/logs")
        path = root / relative
        if ".." in relative.parts or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError("Evidence path escapes trial directory")
        if path.is_symlink() or not path.is_file():
            raise ValueError("Evidence file missing or replaced by a symlink")
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != digest:
            raise ValueError("Evidence digest mismatch")
        verified[str(relative)] = actual
    return verified


class PinnedModalEnvironment(ModalEnvironment):
    def __init__(
        self,
        *args,
        image_pin: dict,
        approved: bool = False,
        preflight: bool = False,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        if (
            self._compose_mode
            or self._gpu_config() is not None
            or self.network_policy.network_mode.value != "public"
            or self._dynamic_network
            or self._persistent_env
            or self._secrets
            or self._volumes
        ):
            raise ValueError("Configuration outside the audited 89-task Modal profile")
        self.pin = image_pin
        self.approved = approved
        self.preflight_only = preflight
        self.lifecycle: dict = {
            "image_pin": image_pin,
            "cpu": self._cpu_config(),
            "memory_mib": self._memory_config(),
            "declared_storage_mib": self.task_env_config.storage_mb,
            "modal_storage_request": None,
            "sandbox_timeout_seconds": self._sandbox_timeout,
            "sdk_internal_retries": "Not exposed by Modal SDK; not scored attempts",
            "sandbox_created": False,
            "termination_confirmed": False,
            "evidence_verified": False,
        }
        self.started = 0.0
        self.stopped = False

    @property
    def evidence_root(self) -> Path:
        return self.trial_paths.trial_dir

    def record(self, operation: str, state: str, **fields: object) -> None:
        self.evidence_root.mkdir(parents=True, exist_ok=True)
        with (self.evidence_root / "modal-events.jsonl").open("a") as stream:
            stream.write(
                json.dumps(
                    {
                        "time": time.time(),
                        "operation": operation,
                        "state": state,
                        **fields,
                    }
                )
                + "\n"
            )
            stream.flush()
            os.fsync(stream.fileno())
        save(self.evidence_root / "modal-lifecycle.json", self.lifecycle)

    async def transfer[T](self, operation: str, call: Callable[[], Awaitable[T]]) -> T:
        for attempt in (1, 2):
            self.record(operation, "started", attempt=attempt)
            try:
                result = await asyncio.wait_for(call(), timeout=TRANSFER_SECONDS)
            except (OSError, TimeoutError) as error:
                self.record(
                    operation, "failed", attempt=attempt, error=type(error).__name__
                )
                if attempt == 2:
                    raise
            except Exception as error:
                self.record(
                    operation, "failed", attempt=attempt, error=type(error).__name__
                )
                raise
            else:
                self.record(operation, "finished", attempt=attempt)
                return result
        raise RuntimeError("Transfer attempts exhausted")

    async def start(self, force_build: bool) -> None:
        if not self.approved or force_build:
            raise ValueError(
                "Explicit compute approval required; forced builds prohibited"
            )
        if not 1 <= self._sandbox_timeout <= 86400:
            raise ValueError("Finite sandbox lifetime required")
        if self.pin["tag"] != self.task_env_config.docker_image:
            raise ValueError("Image pin does not match the original task")
        self.started = time.monotonic()
        self.record("create", "started", attempt=1)
        try:
            self._app = await App.lookup.aio(
                "jev-terminal-bench", create_if_missing=True
            )
            if self.preflight_only:
                credentials = registry_credentials()
                registry_secret = (
                    Secret.from_dict(
                        {
                            "REGISTRY_USERNAME": credentials.username,
                            "REGISTRY_PASSWORD": credentials.token,
                        }
                    )
                    if credentials
                    else None
                )
                self._image = Image.from_registry(
                    self.pin["oci_reference"], secret=registry_secret
                )
            else:
                self._image = await Image.from_id.aio(self.pin["modal_image_id"])
            self._sandbox = await Sandbox.create.aio(
                "sh",
                "-c",
                "sleep infinity",
                app=self._app,
                name=self.session_id,
                image=self._image,
                cpu=self._cpu_config(),
                memory=self._memory_config(),
                timeout=self._sandbox_timeout,
            )
            self.lifecycle.update(
                sandbox_created=True,
                sandbox_id=self._sandbox.object_id,
                modal_image_id=self._image.object_id,
            )
            self.record("create", "finished", attempt=1)
            if (
                not self.preflight_only
                and self._image.object_id != self.pin["modal_image_id"]
            ):
                raise ValueError("Modal image identity mismatch")
            if workdir := self.task_env_config.workdir:
                result = await self._sdk_exec(f"mkdir -p {shlex.quote(workdir)}")
                if result.return_code:
                    raise RuntimeError("Task workdir creation failed")
            await self.ensure_dirs(
                [*self._mount_targets(writable_only=True), "/logs/artifacts"]
            )
            await self._upload_environment_dir_after_start()
        except BaseException as error:
            self.record("create", "failed", attempt=1, error=type(error).__name__)
            raise

    async def _sdk_exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        shell: str = "bash",
        login: bool = False,
    ) -> ExecResult:
        if self._sandbox is None:
            raise RuntimeError("Sandbox not available")
        process = await self._sandbox.exec.aio(
            shell,
            "-lc" if login else "-c",
            command,
            workdir=cwd,
            env=self._merge_env(env),
            timeout=timeout_sec,
        )
        stdout, stderr = await asyncio.gather(
            process.stdout.read.aio(), process.stderr.read.aio()
        )
        return ExecResult(
            stdout=stdout, stderr=stderr, return_code=await process.wait.aio()
        )

    async def _sdk_upload_file(self, source_path: Path | str, target_path: str) -> None:
        if self._sandbox is None:
            raise RuntimeError("Sandbox not available")
        filesystem = self._sandbox.filesystem
        await self.transfer(
            "upload", lambda: filesystem.copy_from_local.aio(source_path, target_path)
        )

    async def _sdk_download_file(
        self, source_path: str, target_path: Path | str
    ) -> None:
        if self._sandbox is None:
            raise RuntimeError("Sandbox not available")
        filesystem = self._sandbox.filesystem
        await self.transfer(
            "download", lambda: filesystem.copy_to_local.aio(source_path, target_path)
        )

    async def collect_evidence(self) -> None:
        result = await self._sdk_exec(
            "find /logs/agent /logs/verifier /logs/artifacts -type f -exec sha256sum -z {} +",
            timeout_sec=60,
        )
        if result.return_code:
            raise RuntimeError("Remote evidence inventory failed")
        for name in ("agent", "verifier", "artifacts"):
            await self.download_dir(f"/logs/{name}", self.evidence_root / name)
        hashes = verify_downloads(self.evidence_root, result.stdout or "")
        save(self.evidence_root / "modal-evidence-sha256.json", hashes)
        self.lifecycle["evidence_verified"] = True

    async def stop(self, delete: bool) -> None:
        if self.stopped:
            return
        self.stopped = True
        try:
            if self._sandbox is not None:
                try:
                    await asyncio.wait_for(self.collect_evidence(), TRANSFER_SECONDS)
                    self.record("evidence", "verified")
                except Exception as error:
                    self.lifecycle["evidence_error"] = type(error).__name__
                    self.record("evidence", "failed", error=type(error).__name__)
                finally:
                    try:
                        async with asyncio.timeout(CLEANUP_SECONDS):
                            await self.transfer(
                                "terminate", self._sandbox.terminate.aio
                            )
                            await self._sandbox.wait.aio(raise_on_termination=False)
                        self.lifecycle["termination_confirmed"] = True
                    except Exception as error:
                        self.lifecycle["cleanup_error"] = type(error).__name__
        finally:
            self.lifecycle["elapsed_seconds"] = (
                time.monotonic() - self.started if self.started else 0
            )
            self.record("cleanup", "finished")
