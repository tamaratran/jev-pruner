import argparse
import asyncio
import hashlib
import json
import tempfile
import unittest
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from harbor.environments.base import ExecResult
from harbor.models.task.config import EnvironmentConfig as TaskEnvironment
from harbor.models.trial.config import ResourceMode
from harbor.models.trial.paths import TrialPaths
from modal.billing import BillingReportItem

from evals.modal_images import checked_digest, resolve_image
from evals.modal_provider import PinnedModalEnvironment, verify_downloads
from evals.modal_runner import (
    budget_reservation,
    ensure_budget,
    execute,
    refresh_budget,
    trial_config,
)


def provider(root: Path, approved: bool = False) -> PinnedModalEnvironment:
    environment = root / "environment"
    environment.mkdir(exist_ok=True)
    (environment / "Dockerfile").write_text("FROM ubuntu:24.04\nWORKDIR /app\n")
    return PinnedModalEnvironment(
        environment_dir=environment,
        environment_name="fixture",
        session_id="fixture",
        trial_paths=TrialPaths(trial_dir=root / "trial"),
        task_env_config=TaskEnvironment(
            docker_image="org/image:tag", cpus=4, memory_mb=8192
        ),
        image_pin={
            "tag": "org/image:tag",
            "oci_reference": "docker.io/org/image@sha256:" + "a" * 64,
            "modal_image_id": "im-fixture",
        },
        approved=approved,
        sandbox_timeout_secs=810,
        cpu_enforcement_policy=ResourceMode.GUARANTEE,
        memory_enforcement_policy=ResourceMode.GUARANTEE,
    )


class ModalTests(unittest.IsolatedAsyncioTestCase):
    async def test_provider_usage_retains_build_margin_and_cannot_lower_budget(
        self,
    ) -> None:
        reconciliations: list[dict] = []
        ledger = {
            "accounted_usd": 1,
            "held_build_reserve_usd": 0.25,
            "unreconciled_import": True,
            "reconciliations": reconciliations,
        }
        item = BillingReportItem(
            object_id="ap-fixture",
            description="fixture",
            environment_name="main",
            interval_start=datetime(2026, 9, 18, tzinfo=timezone.utc),
            cost=Decimal("2"),
            cost_by_resource={"CPU": Decimal("2")},
            tags={},
        )
        with patch("evals.modal_runner.Workspace.from_context") as workspace:
            report = workspace.return_value.billing.report.aio
            report.side_effect = AsyncMock(side_effect=[[item], []])
            await refresh_budget(ledger, date(2026, 9, 18))
            self.assertEqual(ledger["accounted_usd"], 2.25)
            self.assertFalse(ledger["unreconciled_import"])
            await refresh_budget(ledger, date(2026, 9, 18))
            self.assertEqual(ledger["accounted_usd"], 2.25)
            self.assertEqual(len(reconciliations), 2)

    async def test_no_remote_calls_without_approval(self) -> None:
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("evals.modal_provider.App.lookup") as lookup,
            patch("evals.modal_provider.Sandbox.create") as create,
        ):
            environment = provider(Path(directory))
            self.assertEqual(environment._cpu_config(), (4, 4))
            self.assertEqual(environment._memory_config(), (8192, 8192))
            with self.assertRaisesRegex(ValueError, "approval"):
                await environment.start(False)
            with self.assertRaisesRegex(ValueError, "approval"):
                await execute(
                    argparse.Namespace(command="preflight", approve_modal_compute=False)
                )
            lookup.assert_not_called()
            create.assert_not_called()

    async def test_evidence_download_precedes_cleanup_even_on_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            environment = provider(Path(directory))
            sandbox = MagicMock()
            order = []

            async def collect() -> None:
                order.append("download")
                raise ValueError("corrupt evidence")

            async def terminate() -> None:
                order.append("terminate")

            sandbox.terminate.aio = AsyncMock(side_effect=terminate)
            sandbox.wait.aio = AsyncMock()
            environment._sandbox = sandbox
            with patch.object(environment, "collect_evidence", side_effect=collect):
                await environment.stop(True)
                await environment.stop(True)
            self.assertEqual(order, ["download", "terminate"])
            self.assertFalse(environment.lifecycle["evidence_verified"])
            self.assertTrue(environment.lifecycle["termination_confirmed"])
            sandbox.wait.aio.assert_awaited_once()

    async def test_transport_retries_are_logged_and_cleanup_is_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            environment = provider(Path(directory))
            upload = AsyncMock(side_effect=[OSError("fixture"), None])
            await environment.transfer("upload", upload)
            self.assertEqual(upload.await_count, 2)
            events = [
                json.loads(line)
                for line in (environment.evidence_root / "modal-events.jsonl")
                .read_text()
                .splitlines()
            ]
            self.assertEqual(
                [(item["state"], item["attempt"]) for item in events],
                [("started", 1), ("failed", 1), ("started", 2), ("finished", 2)],
            )
            sandbox = MagicMock()
            sandbox.terminate.aio = AsyncMock()
            sandbox.wait.aio = AsyncMock(side_effect=lambda **kwargs: None)

            async def hang(**kwargs) -> None:
                await asyncio.Future()

            sandbox.wait.aio.side_effect = hang
            environment._sandbox = sandbox
            with (
                patch.object(environment, "collect_evidence", new_callable=AsyncMock),
                patch("evals.modal_provider.CLEANUP_SECONDS", 0.01),
            ):
                await asyncio.wait_for(environment.stop(True), timeout=1)
            self.assertFalse(environment.lifecycle["termination_confirmed"])
            self.assertEqual(environment.lifecycle["cleanup_error"], "TimeoutError")

    async def test_sandbox_reuses_image_id_and_never_retries_creation(self) -> None:
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("evals.modal_provider.App.lookup") as lookup,
            patch("evals.modal_provider.Image.from_id") as image,
            patch("evals.modal_provider.Image.from_registry") as registry,
            patch("evals.modal_provider.Sandbox.create") as create,
        ):
            environment = provider(Path(directory), approved=True)
            lookup.aio = AsyncMock()
            image.aio = AsyncMock(return_value=MagicMock(object_id="im-fixture"))
            create.aio = AsyncMock(side_effect=RuntimeError("registry unavailable"))
            with self.assertRaises(RuntimeError):
                await environment.start(False)
            image.aio.assert_awaited_once_with("im-fixture")
            registry.assert_not_called()
            create.aio.assert_awaited_once()
            self.assertEqual(create.aio.call_args.kwargs["cpu"], (4, 4))
            self.assertEqual(create.aio.call_args.kwargs["memory"], (8192, 8192))
            self.assertEqual(create.aio.call_args.kwargs["timeout"], 810)

    async def test_exec_env_does_not_create_modal_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            environment = provider(Path(directory))
            sandbox = MagicMock()
            process = MagicMock()
            process.stdout.read.aio = AsyncMock(return_value="ok")
            process.stderr.read.aio = AsyncMock(return_value="")
            process.wait.aio = AsyncMock(return_value=0)
            sandbox.exec.aio = AsyncMock(return_value=process)
            environment._sandbox = sandbox
            result = await environment._sdk_exec(
                "command", env={"TYPESAFE_API_KEY": "fixture"}
            )
            self.assertEqual(result, ExecResult(stdout="ok", stderr="", return_code=0))
            self.assertNotIn("secrets", sandbox.exec.aio.call_args.kwargs)

    def test_download_hashes_missing_files_and_escape(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "agent").mkdir()
            file = root / "agent/events.txt"
            file.write_text("payload")
            digest = hashlib.sha256(b"payload").hexdigest()
            inventory = f"{digest}  /logs/agent/events.txt\0"
            self.assertEqual(
                verify_downloads(root, inventory), {"agent/events.txt": digest}
            )
            file.write_text("corrupt")
            with self.assertRaisesRegex(ValueError, "digest"):
                verify_downloads(root, inventory)
            file.unlink()
            with self.assertRaisesRegex(ValueError, "missing"):
                verify_downloads(root, inventory)
            with self.assertRaisesRegex(ValueError, "escapes"):
                verify_downloads(root, f"{digest}  /logs/../private\0")

    def test_budget_refuses_unmeasured_imports_and_overcommit(self) -> None:
        spec = {
            "preflight_lifetime_seconds": 810,
            "build_seconds": 600,
            "runtime_usd_per_second": 0.00005276,
        }
        reserve = budget_reservation(spec, True, 1)
        ledger = {"budget_usd": 5, "accounted_usd": 4, "unreconciled_import": False}
        with self.assertRaisesRegex(ValueError, "exceeds"):
            ensure_budget(ledger, reserve)
        ledger.update(accounted_usd=0, unreconciled_import=True)
        with self.assertRaisesRegex(ValueError, "Reconcile"):
            ensure_budget(ledger, reserve)
        ledger["unreconciled_import"] = False
        ensure_budget(ledger, reserve)

    def test_install_only_preflight_cannot_run_verifier(self) -> None:
        row = {"task": "fixture", "arm": "preflight", "job_name": "fixture"}
        config = trial_config(
            Path("/unused"),
            Path("/benchmark"),
            row,
            {"preflight_lifetime_seconds": 810},
            {},
            approved=False,
        )
        self.assertTrue(config.install_only)
        self.assertTrue(config.verifier.disable)
        self.assertEqual(config.agent.kwargs["version"], "2.1.274")
        self.assertEqual(config.agent.kwargs["reasoning_effort"], "high")
        self.assertFalse(config.environment.kwargs["approved"])

    def test_registry_resolves_and_validates_platform_content(self) -> None:
        config = json.dumps({"os": "linux", "architecture": "amd64"}).encode()
        config_digest = checked_digest(config)
        manifest = json.dumps(
            {"config": {"digest": config_digest}, "layers": []}
        ).encode()
        platform_digest = checked_digest(manifest)
        index = json.dumps(
            {
                "manifests": [
                    {
                        "digest": platform_digest,
                        "platform": {"os": "linux", "architecture": "amd64"},
                    }
                ]
            }
        ).encode()
        responses = []
        for body in (b'{"token":"fixture"}', index, manifest, config):
            response = MagicMock()
            response.__enter__.return_value = response
            response.read.return_value = body
            response.headers = {}
            responses.append(response)
        with patch("evals.modal_images.urlopen", side_effect=responses):
            pin = resolve_image("org/image:tag")
        self.assertEqual(pin["tag_digest"], checked_digest(index))
        self.assertEqual(pin["platform_digest"], platform_digest)
        self.assertTrue(pin["oci_reference"].endswith(platform_digest))
        with self.assertRaisesRegex(ValueError, "mismatch"):
            checked_digest(b"changed", platform_digest)
