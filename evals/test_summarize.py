import json
import tempfile
import unittest
from pathlib import Path

from summarize import summarize_agent, summarize_trial


class SummaryTests(unittest.TestCase):
    def test_missing_final_does_not_report_zero_cost(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            row = summarize_agent(Path(directory), "plugin")
            self.assertIsNone(row["claude_cost_usd_reported"])
            self.assertIsNone(row["claude_usage"])
            self.assertTrue(row["measurement_issues"])

    def test_failed_setup_preserves_missing_reward_and_exception(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            trial = Path(directory) / "pilot-task-control" / "task__id"
            trial.mkdir(parents=True)
            path = trial / "result.json"
            path.write_text(
                json.dumps(
                    {
                        "task_name": "task",
                        "trial_name": "task__id",
                        "task_id": {"git_commit_id": "revision"},
                        "task_checksum": "checksum",
                        "exception_info": {"exception_type": "EnvironmentStartError"},
                        "verifier_result": None,
                    }
                )
            )
            row = summarize_trial(path)
            self.assertIsNone(row["reward"])
            self.assertEqual(
                row["exception"]["exception_type"], "EnvironmentStartError"
            )
            self.assertEqual(row["arm"], "control")

    def test_unfinished_jev_request_and_trim_mismatch_are_flagged(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent = Path(directory)
            evidence = agent / "jev"
            evidence.mkdir()
            (evidence / "activated.json").write_text('{"observerLoaded": true}')
            (evidence / "request-1-started.json").write_text('{"request": {}}')
            (evidence / "log-1.json").write_text(
                json.dumps({"text": "bash output: kept 1/2 chunks (6000→3500 chars)"})
            )
            (agent / "claude-code.txt").write_text(
                "\n".join(
                    json.dumps(event)
                    for event in [
                        {
                            "type": "system",
                            "subtype": "init",
                            "plugins": [
                                {"name": "jev-eval-observer"},
                                {"name": "fast-jev-output"},
                            ],
                        },
                        {
                            "type": "result",
                            "subtype": "success",
                            "total_cost_usd": 0.25,
                            "usage": {
                                "input_tokens": 9,
                                "cache_read_input_tokens": 200,
                            },
                        },
                    ]
                )
            )
            row = summarize_agent(agent, "plugin")
            self.assertEqual(row["claude_cost_usd_reported"], 0.25)
            self.assertEqual(row["claude_usage"]["cache_read_input_tokens"], 200)
            self.assertIsNone(row["jev_cost_usd"])
            self.assertEqual(row["net_chars_saved"], 2500)
            self.assertEqual(len(row["measurement_issues"]), 2)


if __name__ == "__main__":
    unittest.main()
