import json
import unittest

from evals.retention_cohort import CASES, grade


class RetentionGradingTests(unittest.TestCase):
    def test_accepts_complete_answers_including_json_fences(self) -> None:
        for name, (_, expected) in CASES.items():
            with self.subTest(fixture=name):
                self.assertTrue(grade(json.dumps(expected), expected))
                self.assertTrue(
                    grade(f"```json\n{json.dumps(expected)}\n```", expected)
                )

    def test_rejects_missing_wrong_and_wrongly_typed_facts(self) -> None:
        for name, (_, expected) in CASES.items():
            for key, value in expected.items():
                with self.subTest(fixture=name, key=key):
                    missing = {k: v for k, v in expected.items() if k != key}
                    wrong = {
                        **expected,
                        key: value + 1 if isinstance(value, int) else "unknown",
                    }
                    self.assertFalse(grade(json.dumps(missing), expected))
                    self.assertFalse(grade(json.dumps(wrong), expected))
                    if isinstance(value, int):
                        self.assertFalse(
                            grade(json.dumps({**expected, key: str(value)}), expected)
                        )
                        self.assertFalse(
                            grade(json.dumps({**expected, key: True}), expected)
                        )

    def test_ignores_only_instruction_spacing(self) -> None:
        expected = CASES["assembly"][1]
        self.assertTrue(
            grade(json.dumps({**expected, "instruction": "add $0x2a, %rax"}), expected)
        )
        self.assertFalse(
            grade(json.dumps({**expected, "instruction": "sub $0x2a, %rax"}), expected)
        )

    def test_rejects_non_answers(self) -> None:
        expected = CASES["source"][1]
        for answer in ("", "Insufficient output", "null", "[]", "{}", "4700"):
            with self.subTest(answer=answer):
                self.assertFalse(grade(answer, expected))
