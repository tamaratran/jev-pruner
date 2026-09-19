import json
import tempfile
import unittest
from pathlib import Path

from evals.summarize import summarize_agent, summarize_decisions, summarize_trial


class SummaryTests(unittest.TestCase):
    def test_visibility_uses_final_text_and_keeps_missing_measurements_unknown(
        self,
    ) -> None:
        decisions = [
            {
                "version": 1,
                "toolUseId": "first",
                "decision": "pruned",
                "sourceChars": 10000,
                "modelVisibleCharsBefore": 20,
            },
            {
                "version": 1,
                "toolUseId": "missing",
                "decision": "below_threshold",
                "modelVisibleCharsBefore": None,
            },
        ]
        events: list[dict[str, object]] = [
            {
                "message": {
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "first",
                            "name": "Bash",
                            "input": {"command": "make"},
                        },
                        {
                            "type": "tool_use",
                            "id": "second",
                            "name": "Bash",
                            "input": {"command": "make"},
                        },
                        {
                            "type": "tool_use",
                            "id": "read",
                            "name": "Read",
                            "input": {"file_path": "/logs/archive.txt"},
                        },
                    ]
                }
            },
            {
                "message": {
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "first",
                            "content": [{"type": "text", "text": "😀" * 15}],
                        },
                    ]
                }
            },
        ]
        logs = [f"fast-jev-output decision {json.dumps(row)}" for row in decisions]
        records = [{"answer": {"result": {"persistedOutputPath": "/logs/archive.txt"}}}]
        result = summarize_decisions(events, logs, records)
        self.assertEqual(result["visible_output_pairs_measured"], 1)
        self.assertEqual(result["model_visible_char_delta_on_measured_calls"], 10)
        self.assertIsNone(result["visible_output_pairs"][1]["delta_chars"])
        self.assertEqual(result["model_visible_bash_chars"], 30)
        self.assertEqual(result["archive_access_count"], 1)
        self.assertEqual(result["repeated_bash_calls"], 1)
        self.assertEqual(
            result["pruning_decision_counts"], {"pruned": 1, "below_threshold": 1}
        )

    def test_absent_or_malformed_diagnostics_do_not_invent_zero_savings(self) -> None:
        for logs, malformed in (
            ([], 0),
            (["fast-jev-output decision invalid"], 1),
            (
                ['fast-jev-output decision {"version":1,"decision":[],"toolUseId":[]}'],
                1,
            ),
        ):
            result = summarize_decisions([], logs, [])
            self.assertIsNone(result["model_visible_char_delta_on_measured_calls"])
            self.assertEqual(result["malformed_pruning_diagnostics"], malformed)

    def test_within_chunk_only_pruning_is_counted_in_the_transcript(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent = Path(directory)
            evidence = agent / "jev"
            evidence.mkdir()
            (evidence / "log-1.json").write_text(
                json.dumps(
                    {
                        "text": "bash output: kept 3/3 chunks (10000→3500 chars)",
                    }
                )
            )
            (agent / "claude-code.txt").write_text(
                json.dumps(
                    {
                        "type": "user",
                        "message": {
                            "content": [
                                {
                                    "type": "tool_result",
                                    "tool_use_id": "within-chunk",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "[fast-jev-output trimmed 10 more lines from this section]",
                                        }
                                    ],
                                }
                            ]
                        },
                    }
                )
            )
            result = summarize_agent(agent, "plugin")
            self.assertEqual(result["pruned_results_in_transcript"], 1)
            self.assertNotIn(
                "Pruning logs and transcript tool-result counts disagree",
                result["measurement_issues"],
            )

    def test_output_threshold_counts_stderr_and_excludes_references(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent = Path(directory)
            evidence = agent / "jev"
            evidence.mkdir()
            (evidence / "bash-1.json").write_text(
                json.dumps(
                    {"answer": {"result": {"stdout": "a" * 3999, "stderr": "b"}}}
                )
            )
            (evidence / "bash-2.json").write_text(
                json.dumps({"answer": {"result": "reference"}})
            )
            row = summarize_agent(agent, "plugin")
            self.assertEqual(row["bash_calls_observed"], 2)
            self.assertEqual(row["bash_structured_outputs_observed"], 1)
            self.assertEqual(row["bash_max_observed_chars"], 4001)
            self.assertEqual(row["bash_observed_outputs_above_min_chars"], 1)

    def test_cost_basis_and_auxiliary_model_tokens_are_retained(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent = Path(directory)
            (agent / "claude-code.txt").write_text(
                json.dumps(
                    {
                        "type": "result",
                        "subtype": "success",
                        "modelUsage": {
                            "primary": {
                                "inputTokens": 4,
                                "outputTokens": 20,
                                "costBasis": "list",
                            },
                            "auxiliary": {
                                "inputTokens": 100,
                                "outputTokens": 3,
                                "costBasis": "list",
                            },
                        },
                    }
                )
            )
            row = summarize_agent(agent, "control")
            self.assertEqual(row["claude_all_models_usage"]["inputTokens"], 104)
            self.assertEqual(row["claude_all_models_usage"]["outputTokens"], 23)
            self.assertEqual(row["claude_cost_basis"], ["list"])

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
