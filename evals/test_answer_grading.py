import unittest

from evals.answer_grading import score_answer


class AnswerGradingTests(unittest.TestCase):
    expected: dict[str, str | int] = {
        "diagnostic": "ERROR: disk full",
        "exit_status": 1,
    }

    def test_prose_and_fences_are_factual_but_not_requested_format(self) -> None:
        for text in (
            'The output says {"diagnostic":"ERROR: disk full","exit_status":1}.',
            '```json\n{"diagnostic":"ERROR: disk full","exit_status":1}\n```',
        ):
            self.assertEqual(
                score_answer(text, self.expected),
                {"factual_pass": True, "format_pass": False, "strict_pass": False},
            )

    def test_only_predeclared_aliases_are_accepted(self) -> None:
        text = '{"ERROR":"ERROR: disk full","exit_status":1}'
        self.assertFalse(score_answer(text, self.expected)["factual_pass"])
        self.assertEqual(
            score_answer(text, self.expected, {"ERROR": "diagnostic"}),
            {"factual_pass": True, "format_pass": False, "strict_pass": False},
        )

    def test_wrong_facts_can_still_follow_the_format(self) -> None:
        self.assertEqual(
            score_answer(
                '{"diagnostic":"ERROR: disk full","exit_status":0}', self.expected
            ),
            {"factual_pass": False, "format_pass": True, "strict_pass": False},
        )

    def test_rejects_missing_wrong_typed_duplicate_and_conflicting_answers(
        self,
    ) -> None:
        for text in (
            '{"diagnostic":"ERROR: disk full"}',
            '{"diagnostic":"ERROR: disk full","exit_status":"1"}',
            '{"diagnostic":"ERROR: disk full","exit_status":true}',
            '{"diagnostic":"ERROR: disk full","exit_status":0,"exit_status":1}',
            '{"diagnostic":"ERROR: disk full","exit_status":0} or '
            '{"diagnostic":"ERROR: disk full","exit_status":1}',
            "I could not read the output.",
        ):
            self.assertFalse(score_answer(text, self.expected)["factual_pass"], text)

    def test_alias_cannot_override_an_explicit_answer(self) -> None:
        text = '{"ERROR":"ERROR: disk full","diagnostic":"wrong","exit_status":1}'
        self.assertFalse(
            score_answer(text, self.expected, {"ERROR": "diagnostic"})["factual_pass"]
        )

    def test_instruction_spacing_is_normalized_only_for_facts(self) -> None:
        result = score_answer(
            '{"instruction":"add  $0x2a, %rax"}', {"instruction": "add $0x2a,%rax"}
        )
        self.assertTrue(result["factual_pass"])
