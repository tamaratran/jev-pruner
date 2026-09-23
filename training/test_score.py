from pathlib import Path
from unittest.mock import patch

import pytest
from kev import experiment
from kev.model import training_context

from .score import decisions, retention_metrics


def test_boundary_and_false_deletion_denominators():
    items = [
        {"p_keep": .1, "keep": True, "tokens": 10, "runtime_eligible": False},
        {"p_keep": .05, "keep": False, "tokens": 20, "runtime_eligible": False},
        {"p_keep": .9, "keep": True, "tokens": 70, "runtime_eligible": False},
    ]
    report = retention_metrics(items, .1)
    assert report["necessary_false_deletion_rate"] == .5
    assert report["deletion_error_rate"] == .5
    assert report["conditional_estimated_token_reduction"] == .3
    assert report["runtime_eligible_questions"] == 0
    assert sum(group["n"] for group in report["reliability"]) == 3
    assert retention_metrics(items, 0)["deletion_error_rate"] is None
    with pytest.raises(ValueError):
        retention_metrics(items, .2)


def test_prediction_coverage_and_frozen_label_validation():
    records = [{
        "_meta": {"id": "r", "group_id": "mswe_python_o__r-1", "source": "swe_pruner_pro"},
        "state": {"chunks": [{"id": "c1", "text": "output"}]},
        "questions": {"c1": {"label": True}},
    }]
    row = {"id": "r", "question": "c1", "keys": ["false", "true"], "label": 1, "p": [.1, .9]}
    assert decisions(records, [row], 1)[0]["language"] == "python"
    with pytest.raises(ValueError, match="Missing"):
        decisions(records, [], 1)
    with pytest.raises(ValueError, match="duplicate"):
        decisions(records, [row, row], 1)
    with pytest.raises(ValueError, match="labels"):
        decisions(records, [{**row, "label": 0}], 1)


def test_patched_kev_study_uses_suite_context(tmp_path: Path):
    context = {**training_context(6144), "truncate": False}
    with (
        patch.object(experiment, "read_manifest", return_value={"context": context}),
        patch.object(experiment, "LocalPredictor", side_effect=RuntimeError("stop at load")) as predictor,
        pytest.raises(RuntimeError, match="stop at load"),
    ):
        experiment.score_trial("unused", tmp_path, tmp_path, {}, "cpu",
                               {"suite_sha256": "unused"}, None, 0, True)
    assert predictor.call_args.kwargs["context"] == context
