"""Report answer facts separately from the requested JSON format."""

import json
import re

Answer = dict[str, str | int]


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def same_schema(answer: object, expected: Answer) -> bool:
    return (
        isinstance(answer, dict)
        and answer.keys() == expected.keys()
        and all(type(answer[key]) is type(value) for key, value in expected.items())
    )


def same_facts(answer: object, expected: Answer) -> bool:
    if not same_schema(answer, expected) or not isinstance(answer, dict):
        return False
    for key, value in expected.items():
        actual = answer[key]
        if key == "instruction" and isinstance(actual, str) and isinstance(value, str):
            if re.sub(r"\s+", "", actual) != re.sub(r"\s+", "", value):
                return False
        elif actual != value:
            return False
    return True


def score_answer(
    text: str, expected: Answer, aliases: dict[str, str] | None = None
) -> dict[str, bool]:
    decoder = json.JSONDecoder(object_pairs_hook=unique_object)
    try:
        bare = decoder.decode(text.strip())
    except ValueError:
        bare = None
    start = text.find("{")
    try:
        answer, end = decoder.raw_decode(text[start:]) if start >= 0 else (None, 0)
        if "{" in text[start + end :]:
            answer = None
    except ValueError:
        answer = None
    if isinstance(answer, dict) and aliases:
        normalized: dict[str, object] = {}
        for key, value in answer.items():
            if not isinstance(key, str):
                answer = None
                break
            name = aliases[key] if key in aliases else key
            if name in normalized:
                answer = None
                break
            normalized[name] = value
        else:
            answer = normalized
    return {
        "factual_pass": same_facts(answer, expected),
        "format_pass": same_schema(bare, expected),
        "strict_pass": same_facts(bare, expected),
    }
