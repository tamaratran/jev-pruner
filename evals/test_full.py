import unittest

from evals.full import access_blocker, aggregate, failure_category


class FullTests(unittest.TestCase):
    def test_account_errors_stop_but_task_text_does_not(self) -> None:
        self.assertIsNone(
            access_blocker(
                [
                    {
                        "type": "user",
                        "message": {"content": "Simulate an OAuth token rate limit"},
                    }
                ]
            )
        )
        for event in (
            {
                "type": "assistant",
                "error": "rate_limit",
                "message": {"content": "You've hit your limit"},
            },
            {"type": "result", "is_error": True, "result": "Model does not exist"},
            {"type": "rate_limit_event", "rate_limit_info": {"status": "rejected"}},
            {"type": "system", "subtype": "init", "model": "another-model"},
        ):
            with self.subTest(event=event):
                self.assertIsNotNone(access_blocker([event]))
        self.assertIsNone(
            access_blocker(
                [
                    {
                        "type": "rate_limit_event",
                        "rate_limit_info": {"status": "allowed_warning"},
                    }
                ]
            )
        )

    def test_missing_and_blocked_trials_are_preserved_without_zero_rewards(
        self,
    ) -> None:
        rows: list[dict[str, object]] = [
            {"task": "one", "arm": "control", "state": "finished", "reward": 1},
            {"task": "one", "arm": "plugin", "state": "finished", "reward": 0},
            {"task": "two", "arm": "control", "state": "resource_blocked"},
            {"task": "two", "arm": "plugin", "state": "pending"},
        ]
        result = aggregate(rows)
        self.assertEqual(result["expected_trials"], 4)
        self.assertTrue(result["pairs"][0]["disagreement"])
        self.assertIsNone(result["pairs"][1]["disagreement"])
        self.assertIsNone(result["pairs"][1]["control_reward"])
        self.assertEqual(result["aggregate"]["control"]["resource_blocked"], 1)
        self.assertEqual(result["aggregate"]["plugin"]["not_finished"], 1)
        self.assertEqual(
            result["aggregate"]["control"]["claude_estimate_available_trials"], 0
        )
        self.assertIsNone(result["aggregate"]["control"]["subscription_billed_usd"])

    def test_failure_types_are_not_task_reward_failures(self) -> None:
        for kind, expected in (
            ("EnvironmentStartError", "infrastructure"),
            ("AgentSetupTimeoutError", "agent_setup"),
            ("VerifierTimeoutError", "verifier"),
            ("AgentTimeoutError", "agent"),
        ):
            with self.subTest(kind=kind):
                self.assertEqual(
                    failure_category({"exception": {"exception_type": kind}}),
                    expected,
                )
        self.assertEqual(failure_category({"reward": 0}), "task_failure")
        self.assertIsNone(failure_category({"reward": 1}))
