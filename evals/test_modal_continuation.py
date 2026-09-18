import asyncio
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from harbor.environments.base import ExecResult

from evals.auth import SubscriptionCheckpoint
from evals.full import save
from evals.modal_runner import continue_trials, eligible_rows
from evals.test_modal import provider


class ContinuationTests(unittest.IsolatedAsyncioTestCase):
    def test_failed_attempt_is_retained_without_reward_or_retry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            provenance = {"commit": "frozen", "sources": {}, "model": "frozen"}
            save(root / "provenance.json", provenance)
            save(
                root / "budget.json", {"unreconciled_import": False, "accounted_usd": 1}
            )
            rows = [
                {
                    "task": "a",
                    "arm": arm,
                    "job_name": f"a-{arm}",
                    "state": "pending",
                    "reward": None,
                }
                for arm in ("control", "plugin")
            ]
            failed = {**rows[0], "state": "evidence_error", "reward": 1}
            save(root / "progress.json", [failed, rows[1]])
            location = root / "trials" / "a-control"
            location.mkdir(parents=True)
            save(location / "result.json", {"agent_execution": True, "verifier": True})
            lifecycle = {"evidence_verified": False, "termination_confirmed": True}
            save(location / "modal-lifecycle.json", lifecycle)
            document = {"provenance": provenance, "trials": rows}
            with self.assertRaisesRegex(ValueError, "verified evidence"):
                continue_trials(root, document, 1, {})
            retained = continue_trials(
                root, document, 1, {}, retain_failed_attempts=True
            )
            self.assertEqual(retained[0]["state"], "evidence_error")
            self.assertIsNone(retained[0]["reward"])
            self.assertEqual(retained[0]["continuation"]["observed_reward"], 1)
            self.assertEqual(retained[0]["continuation"]["agent_attempts"], 1)
            setups: list[dict] = [
                {"task": "a", "arm": "preflight", "state": "finished"}
            ]
            self.assertEqual(eligible_rows(retained, setups), [retained[1]])
            setups[0]["deferred"] = True
            self.assertEqual(eligible_rows(retained, setups), [])
            lifecycle["termination_confirmed"] = False
            save(location / "modal-lifecycle.json", lifecycle)
            with self.assertRaisesRegex(ValueError, "verified evidence"):
                continue_trials(root, document, 1, {}, retain_failed_attempts=True)
            save(root / "progress.json", [{**failed, "state": "running"}, rows[1]])
            with self.assertRaisesRegex(ValueError, "active trials"):
                continue_trials(root, document, 1, {}, retain_failed_attempts=True)

    def test_subscription_checkpoint_can_save_twice_but_rejects_external_change(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / ".credentials.json"
            destination = root / "download"
            before = {
                "claudeAiOauth": {
                    "accessToken": "fixture-before",
                    "refreshToken": "fixture-refresh",
                    "expiresAt": 4_000_000_000_000,
                }
            }
            save(source, before)
            source.chmod(0o600)
            checkpoint = SubscriptionCheckpoint(source)
            before["claudeAiOauth"]["accessToken"] = "fixture-after"
            save(destination, before)
            self.assertTrue(checkpoint.restore(destination)["changed"])
            save(destination, before)
            self.assertFalse(checkpoint.restore(destination)["changed"])
            before["claudeAiOauth"]["accessToken"] = "fixture-unexpected"
            save(source, before)
            with self.assertRaisesRegex(ValueError, "Controller subscription changed"):
                checkpoint.restore(destination)

    async def test_evidence_hashes_and_download_share_one_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            environment = provider(root)
            digest = hashlib.sha256(b"snapshot").hexdigest()
            inventory = f"{digest}  /logs/.jev-evidence-fixture/agent/log.txt\0"

            async def download(source, destination) -> None:
                self.assertEqual(source, "/logs/.jev-evidence-fixture")
                target = destination / "agent"
                target.mkdir(parents=True)
                (target / "log.txt").write_bytes(b"snapshot")

            with (
                patch("evals.modal_provider.uuid4") as identifier,
                patch.object(
                    environment,
                    "_sdk_exec",
                    new=AsyncMock(
                        return_value=ExecResult(return_code=0, stdout=inventory)
                    ),
                ) as execute,
                patch.object(environment, "download_dir", side_effect=download),
            ):
                identifier.return_value.hex = "fixture"
                await environment.collect_evidence()
                self.assertIn("cp -a /logs/agent", execute.call_args.args[0])
                self.assertTrue(environment.lifecycle["evidence_verified"])
                self.assertEqual(
                    json.loads(
                        (
                            environment.evidence_root / "modal-evidence-sha256.json"
                        ).read_text()
                    ),
                    {"agent/log.txt": digest},
                )

    async def test_role_download_deadline_leaves_teardown_time(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            environment = provider(Path(directory))

            async def hang(*args) -> None:
                await asyncio.Future()

            with (
                patch("evals.modal_provider.ROLE_TRANSFER_SECONDS", 0.01),
                patch(
                    "harbor.environments.modal.ModalEnvironment._sdk_download_dir",
                    side_effect=hang,
                ),
                self.assertRaises(TimeoutError),
            ):
                await environment._sdk_download_dir("/logs/agent", Path(directory))
