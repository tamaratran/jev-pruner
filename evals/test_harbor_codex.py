import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from evals.codex_bench import access_blocked
from evals.harbor_codex import INSTRUCTIONS, MODEL, VERSION, JevCodex


class CodexAdapterTests(unittest.TestCase):
    def test_identical_flags_and_subscription_only_auth(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            auth = root / "auth.json"
            agent = JevCodex(logs_dir=root, model_name=MODEL, version=VERSION)
            flags = []
            for arm in ("control", "plugin"):
                with patch.dict(os.environ, {"JEV_EVAL_ARM": arm}):
                    flags.append(agent.build_cli_flags())
            self.assertEqual(flags[0], flags[1])
            self.assertIn("forced_login_method", flags[0])
            self.assertIn(INSTRUCTIONS.splitlines()[0], flags[0])
            with patch.dict(os.environ, {"JEV_CODEX_AUTH_FILE": str(auth)}):
                auth.write_text(json.dumps({"auth_mode": "chatgpt"}))
                self.assertEqual(agent._resolve_auth_json_path(), auth)
                auth.write_text(json.dumps({"auth_mode": "apikey"}))
                with self.assertRaises(ValueError):
                    agent._resolve_auth_json_path()
                auth.write_text(
                    json.dumps({"auth_mode": "chatgpt", "OPENAI_API_KEY": "fake"})
                )
                with self.assertRaises(ValueError):
                    agent._resolve_auth_json_path()

    def test_account_error_detection_ignores_tool_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            agent = root / "task__trial" / "agent"
            agent.mkdir(parents=True)
            stream = agent / "codex.txt"
            stream.write_text(
                json.dumps({"type": "item.completed", "text": "rate limit 429"}) + "\n"
            )
            self.assertFalse(access_blocked(root))
            stream.write_text(
                json.dumps({"type": "turn.failed", "error": {"message": "usage limit"}})
                + "\n"
            )
            self.assertTrue(access_blocked(root))
