import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from evals.codex_bench import access_blocked, blocking_failure
from evals.harbor_codex import INSTRUCTIONS, MODEL, VERSION, JevCodex


class CodexAdapterTests(unittest.TestCase):
    def test_codex_crash_blocks_queue_but_task_output_does_not(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            trial = root / "task__trial"
            (trial / "agent").mkdir(parents=True)
            (trial / "agent" / "codex.txt").write_text(
                json.dumps(
                    {
                        "type": "item.completed",
                        "text": "Command failed (exit 101): failed printing to stdout",
                    }
                )
                + "\n"
            )
            result = {
                "agent_execution": {"started_at": "2026-09-22T00:00:00Z"},
                "exception_info": None,
            }
            (trial / "result.json").write_text(json.dumps(result))
            self.assertIsNone(blocking_failure(root))
            result["exception_info"] = {
                "exception_type": "NonZeroAgentExitCodeError",
                "exception_message": "Command failed (exit 101): codex exec",
            }
            (trial / "result.json").write_text(json.dumps(result))
            self.assertEqual(
                blocking_failure(root), "Codex process exited with status 101"
            )

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

    def test_task_errors_do_not_block_other_trials(self) -> None:
        messages = [
            "This operation is not supported by the tool",
            "The requested file is not available",
            "Assertion failed at line 401",
            "Expected 429 records, found 430",
            "Task service returned 401 Unauthorized",
            "Task service returned 429 Too Many Requests",
            "Task authentication failed",
            "Could not read the refresh token example",
            "The rate_limit fixture is not available",
            "The task's usage limit assertion failed",
            "unexpected status 500 Internal Server Error: request 429",
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            agent = root / "task__trial" / "agent"
            agent.mkdir(parents=True)
            stream = agent / "codex.txt"
            for message in messages:
                for kind in ("error", "turn.failed"):
                    with self.subTest(message=message, kind=kind):
                        event: dict[str, object] = {
                            "type": kind,
                            "request_id": "401-429-authentication",
                        }
                        if kind == "error":
                            event["message"] = message
                        else:
                            event["error"] = {"message": message}
                        stream.write_text(json.dumps(event) + "\n")
                        self.assertFalse(access_blocked(root))

    def test_pinned_codex_account_messages_block_trials(self) -> None:
        messages = [
            "You've hit your usage limit. Try again tomorrow.",
            "You've hit your usage limit for GPT-5.5. Switch to another model now.",
            "rate limit exceeded: Too many requests",
            "Quota exceeded. Check your plan and billing details.",
            "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
            "Your access token could not be refreshed. Please log out and sign in again.",
            "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
            "unexpected status 401 Unauthorized: Invalid token, url: https://chatgpt.com/backend-api/codex/responses",
            "unexpected status 429 Too Many Requests: Rate limit reached",
            "exceeded retry limit, last status: 401 Unauthorized",
            "exceeded retry limit, last status: 429 Too Many Requests, request id: example",
            "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            agent = root / "task__trial" / "agent"
            agent.mkdir(parents=True)
            stream = agent / "codex.txt"
            for message in messages:
                for kind in ("error", "turn.failed"):
                    with self.subTest(message=message, kind=kind):
                        event: dict[str, object] = {"type": kind}
                        if kind == "error":
                            event["message"] = message
                        else:
                            event["error"] = {"message": message}
                        stream.write_text(json.dumps(event) + "\n")
                        self.assertTrue(access_blocked(root))
