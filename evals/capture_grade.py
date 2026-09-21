"""Grade captured answers using frozen official scorers, outside task VMs."""

import argparse
import hashlib
import json
from collections.abc import Callable
from pathlib import Path
from runpy import run_path
from typing import cast

from openai import APIStatusError, OpenAI


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    root: Path = args.root.resolve()
    protocol = json.loads((root / "protocol.json").read_text())
    for name, expected in protocol["scorer_sha256"].items():
        assert (
            hashlib.sha256((root / "sources" / name).read_bytes()).hexdigest()
            == expected
        )
    question_scorer = cast(
        Callable[[str, str], bool],
        run_path(str(root / "sources" / "dab_scorer.py"))["question_scorer"],
    )
    eval_score = cast(
        Callable[[str, str, str], float],
        run_path(str(root / "sources" / "eval_score.py"))["eval_score"],
    )
    audit = json.loads((root / "capture-audit.json").read_text())
    selection = json.loads((root / "selection.json").read_text())
    output = root / "grading"
    output.mkdir(exist_ok=True)
    client = OpenAI(max_retries=0, timeout=60)
    prompt = (root / "sources" / "prompt_for_answer_extraction.md").read_text()
    for row in audit["rows"]:
        if row["family"] == "compile":
            continue
        destination = output / f"{row['task']}.json"
        if destination.exists() or not row["final_answer"]:
            continue
        result: dict[str, object] = {
            "task": row["task"],
            "family": row["family"],
            "response": row["final_answer"],
            "status": "started",
            "score": None,
        }
        destination.write_text(json.dumps(result, indent=2) + "\n")
        try:
            if row["family"] == "dab":
                sample = next(
                    item
                    for item in selection["dab"]
                    if f"dab-{item['task_id']}" == row["task"]
                )
                result["score"] = float(
                    question_scorer(row["final_answer"], sample["answer"])
                )
                result["method"] = "DABstep official question_scorer"
            else:
                sample = next(
                    item
                    for item in selection["pdf"]
                    if f"pdf-{item['source_index']}" == row["task"]
                )
                assert sample["answer_format"] in ("Int", "Float", "Str", "None")
                response = client.chat.completions.create(
                    model="gpt-4o",
                    messages=[
                        {"role": "user", "content": prompt},
                        {
                            "role": "assistant",
                            "content": (
                                f"\n\nQuestion:{sample['question']}"
                                f"\nAnalysis:{row['final_answer']}\n"
                            ),
                        },
                    ],
                    temperature=0.0,
                    max_tokens=256,
                    top_p=1,
                    frequency_penalty=0,
                    presence_penalty=0,
                )
                extracted = response.choices[0].message.content
                assert extracted is not None
                result["extracted"] = extracted
                result["extraction_response"] = response.model_dump()
                result["score"] = eval_score(
                    sample["answer"], extracted, sample["answer_format"]
                )
                result["method"] = "Official GPT-4o extraction prompt and eval_score"
                if response.usage:
                    result["normalized_grading_usd"] = (
                        response.usage.prompt_tokens * 2.5
                        + response.usage.completion_tokens * 10
                    ) / 1e6
            result["status"] = "finished"
        except Exception as error:
            result["status"] = "failed"
            result["error"] = type(error).__name__
            if isinstance(error, APIStatusError):
                result["http_status"] = error.status_code
        destination.write_text(json.dumps(result, indent=2) + "\n")
        print(row["task"], result["status"], result["score"])


if __name__ == "__main__":
    main()
