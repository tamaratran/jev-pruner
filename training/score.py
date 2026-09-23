"""Report retention risk from Kev benchmark rows; never selects on the locked test."""

import argparse
import json
import math
import re
from collections import defaultdict
from pathlib import Path

from kev.metrics import metrics, probabilities_at_temperature
from kev.suite import digest, load_split, read_json, write_json


def decisions(records, rows, temperature):
    lookup = {(record["_meta"]["id"], qid): (record, question)
              for record in records for qid, question in record["questions"].items()}
    seen = set()
    result = []
    for row in rows:
        key = (row["id"], row["question"])
        if key not in lookup or key in seen:
            raise ValueError("Unknown or duplicate prediction")
        seen.add(key)
        record, question = lookup[key]
        if row["keys"] != ["false", "true"] or row["label"] != int(question["label"]):
            raise ValueError("Prediction options or labels differ from the frozen suite")
        p_keep = float(probabilities_at_temperature(row, temperature)[1])
        if not math.isfinite(p_keep) or not 0 <= p_keep <= 1:
            raise ValueError("Invalid retention probability")
        state = record["state"]
        chunk = next(chunk for chunk in state["chunks"] if chunk["id"] == row["question"])
        meta = record["_meta"]
        language = re.match(r"mswe_([^_]+)_", meta["group_id"])
        tokens = math.ceil(len(chunk["text"].encode("utf-16-le")) / 8)
        history_length = len(json.dumps(state.get("history", []), ensure_ascii=False))
        command = state.get("command") or ""
        result.append({
            "keep": bool(row["label"]), "p_keep": p_keep, "tokens": tokens,
            "repository": meta.get("repository", "seed"),
            "source": meta["source"], "confidence": meta.get("confidence", "constructed"),
            "language": language[1] if language else "unknown",
            "command": command.split()[0] if command.strip() else "unknown",
            "history_chars": "<4000" if history_length < 4000 else ">=4000",
            "chunk_tokens": "<100" if tokens < 100 else "<500" if tokens < 500 else ">=500",
            "runtime_eligible": meta.get("runtimeEligible"),
        })
    if seen != set(lookup):
        raise ValueError("Missing predictions")
    return result


def retention_metrics(items, cutoff):
    if not math.isfinite(cutoff) or not 0 <= cutoff <= 0.1:
        raise ValueError("Drop cutoff must be between zero and 0.1")
    drops = [item for item in items if item["p_keep"] <= cutoff]
    false_drops = sum(item["keep"] for item in drops)
    necessary = sum(item["keep"] for item in items)
    tokens = sum(item["tokens"] for item in items)
    reliability = []
    for low, high in zip((0, .01, .02, .05, .1, .2, .5, .8, .9),
                         (.01, .02, .05, .1, .2, .5, .8, .9, 1), strict=True):
        group = [item for item in items if low <= item["p_keep"] < high
                 or high == 1 and item["p_keep"] == 1]
        reliability.append({
            "low": low, "high": high, "n": len(group),
            "mean_p_keep": sum(item["p_keep"] for item in group) / len(group) if group else None,
            "observed_keep": sum(item["keep"] for item in group) / len(group) if group else None,
        })
    return {
        "n": len(items), "necessary": necessary, "drops": len(drops),
        "false_drops": false_drops,
        "necessary_false_deletion_rate": false_drops / necessary if necessary else None,
        "deletion_error_rate": false_drops / len(drops) if drops else None,
        "conditional_estimated_token_reduction": sum(item["tokens"] for item in drops) / tokens if tokens else 0,
        "runtime_eligible_questions": sum(item["runtime_eligible"] is True for item in items),
        "reliability": reliability,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", type=Path, required=True)
    parser.add_argument("--rows", type=Path, required=True)
    parser.add_argument("--temperature", type=float, default=1.0)
    parser.add_argument("--cutoff", type=float, default=0.1)
    parser.add_argument("--split", choices=("development", "test"), default="development")
    parser.add_argument("--allow-test", action="store_true")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise ValueError("Report already exists")
    records = load_split(args.suite, args.split, allow_test=args.allow_test)
    rows = read_json(args.rows)
    items = decisions(records, rows, args.temperature)
    groups = {}
    for dimension in ("repository", "source", "confidence", "language", "command",
                      "history_chars", "chunk_tokens"):
        grouped = defaultdict(list)
        for item in items:
            grouped[item[dimension]].append(item)
        groups[dimension] = {key: retention_metrics(group, args.cutoff)
                             for key, group in sorted(grouped.items())}
    report = {
        "suite_sha256": digest(args.suite / "manifest.json"), "rows_sha256": digest(args.rows),
        "split": args.split, "temperature": args.temperature, "cutoff": args.cutoff,
        "rule": "drop if P(keep) <= cutoff; deployment threshold must be greater than cutoff",
        "scope": "Conditional sampled-chunk estimates, excluding protected-line overrides, separators, and activation gate; not production savings.",
        "classification": metrics(rows, args.temperature),
        "retention": retention_metrics(items, args.cutoff),
        "groups": groups,
    }
    if args.split == "development":
        report["development_cutoffs"] = {
            str(cutoff): retention_metrics(items, cutoff) for cutoff in (0, .01, .02, .05, .1)
        }
    write_json(args.out, report)
    print(json.dumps({key: value for key, value in report.items() if key != "groups"}, indent=2))


if __name__ == "__main__":
    main()
