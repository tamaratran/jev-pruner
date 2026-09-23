import json
import sys
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import patch

import pytest
from kev.checkpoint import Meta
from kev.experiment import load_plan
from kev.suite import read_json, read_jsonl, write_json, write_jsonl

from . import freeze


@pytest.fixture
def inputs(tmp_path: Path) -> Iterator[Path]:
    repositories = {}
    for index in range(1000):
        repository = f"owner/repo-{index}"
        repositories.setdefault(freeze.partition(repository), repository)
    assert set(repositories) == set(freeze.SPLITS)
    candidates = [
        {
            "id": split, "issue": f"{repository}-42", "repository": repository,
            "state": {"task": split, "output": "progress\nuseful result"},
            "questions": {
                "c1": {"type": "noul", "instructions": "Keep progress?"},
                "c2": {"type": "noul", "instructions": "Keep result?"},
            },
            "candidateDrops": ["c1"], "provenance": {},
        }
        for split, repository in repositories.items()
    ]
    write_jsonl(tmp_path / "candidates.jsonl", candidates)
    reviews = [
        {
            "id": candidate["id"], "candidateHash": freeze.sha(raw),
            "drops": [{"id": "c1", "reason": "Test fixture: explicitly disposable progress."}],
            "method": "source-candidate-plus-model-policy-review", "model": "test-stub",
        }
        for candidate, raw in zip(
            candidates, (tmp_path / "candidates.jsonl").read_text().splitlines(), strict=True
        )
    ]
    write_jsonl(tmp_path / "reviews.jsonl", reviews)
    replay = tmp_path / "kev/evals/v7/decision-v7"
    replay.mkdir(parents=True)
    write_json(replay / "manifest.json", {})
    seed = tmp_path / "seed"
    seed.mkdir()
    write_json(seed / "seed-provenance.json", {
        "records": [{"split": split, "id": split, "family": split} for split in freeze.SPLITS]
    })
    for split in freeze.SPLITS:
        write_jsonl(seed / f"{split}.jsonl", [{
            "state": f"Previously inspected seed {split}",
            "questions": {"c1": {"type": "noul", "instructions": "Keep?", "label": True}},
        }])
    argv = [
        "freeze.py", "--candidates", str(tmp_path / "candidates.jsonl"),
        "--reviews", str(tmp_path / "reviews.jsonl"), "--out", str(tmp_path / "suite"),
        "--kev", str(tmp_path / "kev"), "--seed-data", str(seed),
    ]
    with (
        patch.object(sys, "argv", argv),
        patch.object(freeze, "Checkpoint") as checkpoint,
        patch.object(freeze, "load_tokenizer"),
        patch.object(freeze, "fits", return_value=True),
        patch.object(freeze, "load_split", return_value=[]),
    ):
        checkpoint.return_value.meta = Meta(base="test/base", base_revision="a" * 40, lora=16)
        yield tmp_path


def test_freeze_keeps_inspected_seed_out_of_locked_test(inputs: Path) -> None:
    freeze.main()
    suite = inputs / "suite"
    manifest = read_json(suite / "manifest.json")
    assert len(load_plan(suite, suite / "plan.json")) == 1
    for split in freeze.SPLITS:
        rows = read_jsonl(suite / f"{split}.jsonl")
        external = [row for row in rows if row["_meta"]["source"] == "swe_pruner_pro"]
        assert len(external) == 2
        assert {q["label"] for row in external for q in row["questions"].values()} == {False, True}
        assert manifest["files"][f"{split}.jsonl"]["retention_drop"] == 1
    assert all(row["_meta"]["source"] != "pruner_seed" for row in read_jsonl(suite / "test.jsonl"))
    assert read_jsonl(suite / "regression.jsonl")[0]["_meta"]["split"] == "regression"
    with pytest.raises(ValueError, match="new directory"):
        freeze.main()


@pytest.mark.parametrize("failure", ["stale", "missing", "unauthorized", "no-rationale"])
def test_freeze_rejects_unreviewed_negatives(inputs: Path, failure: str) -> None:
    path = inputs / "reviews.jsonl"
    reviews = read_jsonl(path)
    if failure == "stale":
        reviews[0]["candidateHash"] = "stale"
    elif failure == "missing":
        reviews.pop()
    elif failure == "unauthorized":
        reviews[0]["drops"][0]["id"] = "c2"
    else:
        reviews[0]["drops"][0]["reason"] = ""
    write_jsonl(path, reviews)
    with pytest.raises(ValueError):
        freeze.main()
    assert not (inputs / "suite").exists()


def test_context_rejection_cannot_silently_empty_a_partition(inputs: Path) -> None:
    with patch.object(freeze, "fits", return_value=False), pytest.raises(ValueError):
        freeze.main()
    assert not (inputs / "suite").exists()


def test_identical_states_cannot_cross_partitions(inputs: Path) -> None:
    candidates_path = inputs / "candidates.jsonl"
    reviews_path = inputs / "reviews.jsonl"
    candidates = read_jsonl(candidates_path)
    candidates[1]["state"] = candidates[0]["state"]
    write_jsonl(candidates_path, candidates)
    reviews = read_jsonl(reviews_path)
    reviews[1]["candidateHash"] = freeze.sha(json.dumps(candidates[1], ensure_ascii=False))
    write_jsonl(reviews_path, reviews)
    with pytest.raises(ValueError, match="Empty .* partition|lacks both retention classes"):
        freeze.main()
    assert not (inputs / "suite").exists()
