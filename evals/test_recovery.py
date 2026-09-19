import unittest

from evals.summarize import summarize_decisions


class RecoveryTests(unittest.TestCase):
    def test_compact_footer_tracks_only_prior_prunes_and_the_stated_reason(
        self,
    ) -> None:
        path = "/logs/archive.txt"
        events: list[dict[str, object]] = [
            {
                "message": {
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "early",
                            "name": "Read",
                            "input": {"file_path": path},
                        },
                        {
                            "type": "tool_use",
                            "id": "build",
                            "name": "Bash",
                            "input": {"command": "make"},
                        },
                    ]
                }
            },
            {
                "message": {
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "build",
                            "content": "[fast-jev-output trimmed; retained lines verbatim; omissions marked]\n"
                            f"[100 lines omitted]\n[fast-jev-output full output: {path} (Read or grep it if needed)]",
                        },
                    ]
                }
            },
            {
                "message": {
                    "content": [
                        {"type": "text", "text": "I need the missing artifact name."},
                        {
                            "type": "tool_use",
                            "id": "recovery",
                            "name": "Read",
                            "input": {"file_path": path},
                        },
                    ]
                }
            },
            {
                "message": {
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "recovery",
                            "content": "full log",
                        },
                    ]
                }
            },
            {
                "message": {
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "again",
                            "name": "Read",
                            "input": {"file_path": path},
                        },
                    ]
                }
            },
        ]
        result = summarize_decisions(events, [], [])
        early, recovery, again = result["archive_accesses_observed"]
        self.assertEqual(early["after_pruned_tool_ids"], [])
        self.assertEqual(recovery["after_pruned_tool_ids"], ["build"])
        self.assertEqual(recovery["stated_reason"], "I need the missing artifact name.")
        self.assertIsNone(again["stated_reason"])
        self.assertEqual(recovery["reason_classification"], "unreviewed")
