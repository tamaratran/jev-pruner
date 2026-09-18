import base64
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from evals.modal_images import resolve_image
from evals.registry_auth import RegistryCredentials, registry_credentials
from evals.test_modal import provider


class RegistryAuthTests(unittest.IsolatedAsyncioTestCase):
    def test_credentials_require_private_storage_and_have_no_secret_repr(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "registry.json"
            path.write_text(
                json.dumps({"username": "fixture", "token": "private-token"})
            )
            path.chmod(0o600)
            with patch.dict(os.environ, {"JEV_EVAL_DOCKER_AUTH_FILE": str(path)}):
                credentials = registry_credentials()
                assert credentials is not None
                self.assertEqual(credentials.token, "private-token")
                self.assertNotIn("private-token", repr(credentials))
                path.chmod(0o644)
                with self.assertRaisesRegex(ValueError, "private"):
                    registry_credentials()
                path.chmod(0o600)
                with patch.dict(os.environ, {"EVIDENCE_DIR": directory}):
                    with self.assertRaisesRegex(ValueError, "outside"):
                        registry_credentials()

    def test_basic_credentials_only_reach_docker_token_endpoint(self) -> None:
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b'{"token": "registry-bearer"}'
        with (
            patch(
                "evals.modal_images.registry_credentials",
                return_value=RegistryCredentials("fixture", "private-token"),
            ),
            patch(
                "evals.modal_images.urlopen", side_effect=[response, OSError]
            ) as send,
        ):
            with self.assertRaises(OSError):
                resolve_image("org/image:tag")
        requests = [call.args[0] for call in send.call_args_list]
        self.assertTrue(requests[0].full_url.startswith("https://auth.docker.io/"))
        self.assertEqual(
            requests[0].get_header("Authorization"),
            "Basic " + base64.b64encode(b"fixture:private-token").decode(),
        )
        self.assertEqual(
            requests[1].get_header("Authorization"), "Bearer registry-bearer"
        )

    async def test_registry_secret_is_not_a_sandbox_or_exec_secret(self) -> None:
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("evals.modal_provider.App.lookup") as lookup,
            patch("evals.modal_provider.Image.from_registry") as image,
            patch("evals.modal_provider.Sandbox.create") as create,
            patch("evals.modal_provider.Secret.from_dict") as secret,
            patch(
                "evals.modal_provider.registry_credentials",
                return_value=RegistryCredentials("fixture", "private-token"),
            ),
        ):
            environment = provider(Path(directory), approved=True)
            environment.preflight_only = True
            lookup.aio = AsyncMock()
            create.aio = AsyncMock(side_effect=RuntimeError("fixture stop"))
            with self.assertRaisesRegex(RuntimeError, "fixture stop"):
                await environment.start(False)
            secret.assert_called_once_with(
                {"REGISTRY_USERNAME": "fixture", "REGISTRY_PASSWORD": "private-token"}
            )
            self.assertIs(image.call_args.kwargs["secret"], secret.return_value)
            self.assertNotIn("secrets", create.aio.call_args.kwargs)
            self.assertNotIn("env", create.aio.call_args.kwargs)
            self.assertNotIn("private-token", json.dumps(environment.lifecycle))
            self.assertEqual(
                environment._merge_env({"FIXTURE": "value"}), {"FIXTURE": "value"}
            )
