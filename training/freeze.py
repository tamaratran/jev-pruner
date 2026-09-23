"""Build a new Kev suite; run with the pinned Kev checkout's Python environment."""

import argparse
import hashlib
import json
import random
from collections import Counter
from pathlib import Path

from kev.checkpoint import Checkpoint
from kev.data import load_records, materialize
from kev.experiment import validated_trial
from kev.model import fits, load_tokenizer, training_context
from kev.suite import digest, load_split, read_json, read_jsonl, validate_training, write_json, write_jsonl

INIT = "jaredpalmer/kev-0.8b@54f4f8777356cd5bbbb6c6919c657f26e6f2f6d8"
SPLITS = ("train", "calibration", "development", "test")


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def partition(repository: str) -> str:
    bucket = int(sha("split-v1:" + repository)[:8], 16) % 100
    return "train" if bucket < 70 else "calibration" if bucket < 80 else "development" if bucket < 90 else "test"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidates", type=Path, required=True)
    parser.add_argument("--reviews", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--kev", type=Path, required=True)
    parser.add_argument("--seed-data", type=Path)
    args = parser.parse_args()
    if args.out.exists():
        raise ValueError("Output must be a new directory; frozen suites are immutable")
    reviews_list = read_jsonl(args.reviews)
    reviews = {review["id"]: review for review in reviews_list}
    if len(reviews) != len(reviews_list):
        raise ValueError("Duplicate reviews")
    checkpoint = Checkpoint(INIT)
    meta = checkpoint.meta
    tokenizer = load_tokenizer(meta.base, revision=meta.base_revision)
    context = training_context(6144)
    partitions = {name: [] for name in SPLITS}
    regressions = []
    state_splits: dict[str, str] = {}
    rejected = Counter()
    for raw in args.candidates.read_text(encoding="utf-8").splitlines():
        candidate = json.loads(raw)
        review = reviews.get(candidate["id"])
        if review is None or review["candidateHash"] != sha(raw):
            raise ValueError(f"Missing or stale review for {candidate['id']}")
        drops = {drop["id"] for drop in review["drops"]}
        if not drops.issubset(candidate["candidateDrops"]) or len(drops) != len(review["drops"]):
            raise ValueError("Review cannot drop a protected or unknown chunk")
        if drops and (review["method"] != "source-candidate-plus-model-policy-review" or
                      not all(drop["reason"].strip() for drop in review["drops"])):
            raise ValueError("Negative labels need policy review and rationale")
        audit = review.get("policyAudit")
        if not isinstance(audit, dict) or audit.get("version") != "protected-evidence-v1":
            raise ValueError("Reviews must pass the deterministic policy audit")
        if drops.intersection(veto["id"] for veto in audit["vetoes"]):
            raise ValueError("A vetoed chunk cannot receive a DROP label")
        split = partition(candidate["repository"])
        state_hash = sha(json.dumps(candidate["state"], sort_keys=True, ensure_ascii=False))
        if state_hash in state_splits and state_splits[state_hash] != split:
            rejected["cross_partition_duplicate_state"] += 1
            continue
        state_splits[state_hash] = split
        for qid, question in candidate["questions"].items():
            record = {
                "state": candidate["state"],
                "questions": {qid: {**question, "label": qid not in drops, "src": "retention"}},
                "_meta": {
                    **candidate["provenance"], "source": "swe_pruner_pro",
                    "id": f"{candidate['id']}/{qid}", "group_id": candidate["issue"],
                    "repository": candidate["repository"], "split": split, "variant": "clean",
                    "annotation": review["method"], "annotationModel": review["model"],
                },
            }
            if fits(materialize(record), tokenizer, **context):
                partitions[split].append(record)
            else:
                rejected["context_overflow"] += 1
    if args.seed_data:
        seed_provenance = read_json(args.seed_data / "seed-provenance.json")["records"]
        for split in SPLITS:
            seed_records = load_records(args.seed_data / f"{split}.jsonl", source="pruner_seed")
            origins = [entry for entry in seed_provenance if entry["split"] == split]
            if len(seed_records) != len(origins):
                raise ValueError("Seed provenance does not match its records")
            for record, origin in zip(seed_records, origins, strict=True):
                record["_meta"].update(
                    id=f"pruner_seed/{origin['id']}",
                    group_id=f"pruner_seed/{origin['family']}",
                    split=split,
                )
                if not fits(materialize(record), tokenizer, **context):
                    raise ValueError("Seed record exceeds the context")
                if split == "test":
                    record["_meta"]["split"] = "regression"
                    regressions.append(record)
                else:
                    partitions[split].append(record)
    public = load_split(args.kev / "evals/v7/decision-v7", "train")
    replay = random.Random(42).sample(public, min(2000, len(public)))
    partitions["train"].extend(replay)
    sources = sorted({record["_meta"]["source"] for record in partitions["train"]})
    manifest = {
        "version": 1, "seed": 42, "base_revisions": {meta.base: meta.base_revision},
        "trainable_sources": sources, "holdout_sources": [], "eval_only_sources": [],
        "context": {**context, "truncate": False},
        "selection": "Repository-disjoint source splits; one sampled request window per response; individual questions; token admission without truncation.",
        "annotation": "Source-positive evidence plus conservative model-reviewed negatives. Silver labels; final agent retention needs independent evaluation.",
        "input_sha256": {"candidates": digest(args.candidates), "reviews": digest(args.reviews)},
        "source": {
            "url": "https://huggingface.co/datasets/ayanami-kitasan/swe-pruner-pro-training-corpus",
            "license_on_dataset_card": "apache-2.0",
            "revision": "6bd52ba1d430eebcd6262a4147c7243cb2e8dd1b",
            "origin": "ByteDance-Seed/Multi-SWE-bench_trajs; benchmark overlap needs a separate audit",
        },
        "replay_manifest_sha256": digest(args.kev / "evals/v7/decision-v7/manifest.json"),
        "seed_test_policy": "Previously inspected seed test records are regression.jsonl, outside the locked test.",
        "init_from": INIT, "replay": len(replay), "rejected": dict(rejected), "files": {},
    }
    for split, records in partitions.items():
        if not records:
            raise ValueError(f"Empty {split} partition")
        labels = Counter(question["label"] for record in records
                         if record["_meta"]["source"] == "swe_pruner_pro"
                         for question in record["questions"].values())
        if labels[False] == 0 or labels[True] == 0:
            raise ValueError(f"{split} lacks both retention classes: {dict(labels)}")
        manifest["files"][f"{split}.jsonl"] = {
            "records": len(records), "questions": sum(len(r["questions"]) for r in records),
            "retention_keep": labels[True], "retention_drop": labels[False],
            "repositories": sorted({r["_meta"]["repository"] for r in records if "repository" in r["_meta"]}),
        }
    validate_training(partitions["train"], manifest)
    plan = [{
        "base": meta.base, "base_revision": meta.base_revision, "init_from": INIT,
        "lr": 1e-5, "epochs": 1, "batch": 1, "accum": 8, "seed": 42,
        "lora": meta.lora, "head_dim": meta.head_dim, "lora_targets": "all",
        "dtype": "bf16", "weights_dtype": meta.weights_dtype, "checkpointing": 1,
        "max_state": 6144, "p_none": 0, "p_none_distract": 0, "p_distract": 0, "p_none_pair": 0,
    }]
    validated_trial(plan[0], manifest)
    args.out.mkdir(parents=True)
    for split, records in partitions.items():
        path = args.out / f"{split}.jsonl"
        write_jsonl(path, records)
        manifest["files"][path.name]["sha256"] = digest(path)
    if regressions:
        path = args.out / "regression.jsonl"
        write_jsonl(path, regressions)
        manifest["files"][path.name] = {"records": len(regressions), "sha256": digest(path)}
    write_json(args.out / "manifest.json", manifest)
    write_json(args.out / "plan.json", plan)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
