import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from evals.full import aggregate, save
from evals.modal_runner import (
    campaign_order,
    continue_trials,
    preflight_manifest,
    retain_trial_summary,
    seed_images,
)


class CampaignTests(unittest.TestCase):
    def test_continuation_preserves_scored_control_and_labels_setup_retry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            provenance = {
                "commit": "old",
                "sources": {},
                "model": "frozen",
                "claude_version": "pinned",
            }
            rows: list[dict] = [
                {
                    "task": "a",
                    "arm": arm,
                    "job_name": f"a-{arm}",
                    "state": "pending",
                    "reward": None,
                }
                for arm in ("control", "plugin")
            ]
            old = copy.deepcopy(rows)
            old[0]["state"] = "finished"
            old[1].update(arm="trials", state="evidence_error")
            save(source / "provenance.json", provenance)
            save(
                source / "budget.json",
                {"accounted_usd": 1, "unreconciled_import": False},
            )
            save(source / "progress.json", old)
            pin = {"modal_image_id": "im-fixture", "oci_reference": "sha256:fixture"}
            for row in rows:
                location = source / "trials" / row["job_name"]
                location.mkdir(parents=True)
                scored = row["arm"] == "control"
                save(
                    location / "result.json",
                    {"agent_execution": scored, "verifier": scored},
                )
                save(
                    location / "modal-lifecycle.json",
                    {
                        "evidence_verified": True,
                        "termination_confirmed": True,
                        "modal_image_id": "im-fixture",
                        "image_pin": pin,
                    },
                )
                files = (
                    {
                        "agent/eval-settings.json": {
                            "auth_mode": "subscription",
                            "auth_status": {
                                "loggedIn": True,
                                "authMethod": "claude.ai",
                                "apiProvider": "firstParty",
                                "subscriptionType": "max",
                            },
                            "model": "frozen",
                            "claude_version": "pinned",
                        },
                        "agent/claude-code.txt": {},
                        "agent/jev/activated.json": {},
                        "verifier/reward.txt": 0,
                    }
                    if scored
                    else {}
                )
                hashes = {}
                for name, data in files.items():
                    file = location / name
                    file.parent.mkdir(parents=True, exist_ok=True)
                    save(file, data)
                    hashes[name] = hashlib.sha256(file.read_bytes()).hexdigest()
                save(location / "modal-evidence-sha256.json", hashes)
            document: dict = {
                "provenance": {**provenance, "commit": "new"},
                "trials": rows,
            }
            summary = {
                "task": "a",
                "arm": "control",
                "reward": 0,
                "measurement_issues": [],
                "exception_phase": None,
                "exception": None,
            }
            with patch("evals.modal_runner.summarize_trial", return_value=summary):
                continued = continue_trials(source, document, 1, {"a": pin})
                self.assertEqual(
                    [row["state"] for row in continued], ["finished", "pending"]
                )
                self.assertEqual(
                    continued[0]["continuation"]["kind"], "preserved_scored_result"
                )
                self.assertEqual(
                    continued[1]["continuation"]["kind"],
                    "retry_before_first_agent_attempt",
                )
                self.assertEqual(continued[1]["arm"], "plugin")
                self.assertIsNone(continued[1]["reward"])
                self.assertEqual(
                    json.loads((source / "progress.json").read_text()), old
                )
                with self.assertRaisesRegex(ValueError, "scored attempt"):
                    continue_trials(
                        source,
                        document,
                        1,
                        {"a": {**pin, "modal_image_id": "different"}},
                    )
                changed = copy.deepcopy(document)
                changed["provenance"]["model"] = "different"
                with self.assertRaisesRegex(ValueError, "frozen"):
                    continue_trials(source, changed, 1, {"a": pin})

    def test_failed_setup_cannot_overwrite_planned_arm(self) -> None:
        row: dict = {"task": "fixture", "arm": "plugin"}
        summary: dict = {
            "task": "fixture",
            "arm": "trials",
            "reward": None,
            "measurement_issues": [],
            "exception_phase": "agent_setup",
            "exception": {"exception_message": "check_auth.cjs: no inference started"},
        }
        retain_trial_summary(row, summary)
        self.assertEqual(row["arm"], "plugin")
        self.assertEqual(row["reported_identity"]["arm"], "trials")
        self.assertEqual(row["failure_category"], "authentication")
        self.assertEqual(row["state"], "setup_error")
        self.assertIsNone(row["reward"])
        result = aggregate(
            [
                {
                    "task": "fixture",
                    "arm": "control",
                    "state": "pending",
                    "reward": None,
                },
                row,
            ]
        )
        self.assertEqual(len(result["trials"]), 2)
        self.assertIsNone(result["pairs"][0]["disagreement"])

    def test_preflight_is_followed_by_both_arms_without_dropping_rows(self) -> None:
        tasks = [{"task": f"task-{i}"} for i in range(89)]
        rows = [
            {"task": task["task"], "arm": arm}
            for i, task in enumerate(tasks)
            for arm in (("control", "plugin") if i % 2 == 0 else ("plugin", "control"))
        ]
        setups = preflight_manifest(tasks)
        ordered = campaign_order(rows, setups)
        self.assertEqual(len(ordered), 267)
        self.assertEqual([row for row in ordered if row["arm"] != "preflight"], rows)
        self.assertEqual(
            [row["arm"] for row in ordered[:6]],
            ["preflight", "control", "plugin", "preflight", "plugin", "control"],
        )
        ordered[1]["state"] = "finished"
        self.assertEqual(rows[0]["state"], "finished")

    def test_seed_requires_matching_experiment_verified_files_and_reserved_cost(
        self,
    ) -> None:
        document: dict = {
            "provenance": {
                "commit": "new",
                "sources": {"runner": "new"},
                "model": "frozen",
                "claude_version": "pinned",
            },
            "tasks": [{"task": "a"}, {"task": "b"}],
        }
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            previous = copy.deepcopy(document["provenance"])
            previous["commit"] = "old"
            previous["sources"] = {"runner": "old"}
            save(source / "provenance.json", previous)
            save(
                source / "budget.json",
                {"accounted_usd": 1, "unreconciled_import": False},
            )
            rows = preflight_manifest(document["tasks"])
            rows[0]["state"] = "finished"
            rows[1]["state"] = "image_error"
            save(source / "progress.json", rows)
            pin = {"modal_image_id": "im-fixture"}
            save(source / "images.json", {"a": pin})
            location = source / "trials/a-preflight"
            (location / "agent").mkdir(parents=True)
            save(
                location / "modal-lifecycle.json",
                {
                    "evidence_verified": True,
                    "termination_confirmed": True,
                    "modal_image_id": "im-fixture",
                },
            )
            hashes = {}
            for name in ("eval-settings.json", "modal-preflight.json"):
                file = location / "agent" / name
                contents: dict = (
                    {"passed": True}
                    if name == "modal-preflight.json"
                    else {
                        "auth_mode": "subscription",
                        "auth_status": {
                            "loggedIn": True,
                            "authMethod": "claude.ai",
                            "apiProvider": "firstParty",
                            "subscriptionType": "max",
                        },
                        "model": "frozen",
                        "claude_version": "pinned",
                    }
                )
                save(file, contents)
                hashes[f"agent/{name}"] = hashlib.sha256(file.read_bytes()).hexdigest()
            save(location / "modal-evidence-sha256.json", hashes)
            adopted, images = seed_images(source, document, 1)
            self.assertEqual([row["state"] for row in adopted], ["finished", "pending"])
            self.assertEqual(adopted[1]["prior_preflight_state"], "image_error")
            self.assertEqual(images, {"a": pin})
            self.assertEqual(json.loads((source / "progress.json").read_text()), rows)
            with self.assertRaisesRegex(ValueError, "reserved"):
                seed_images(source, document, 0)
            changed = copy.deepcopy(document)
            changed["provenance"]["model"] = "different"
            with self.assertRaisesRegex(ValueError, "frozen"):
                seed_images(source, changed, 1)
            (location / "agent/eval-settings.json").write_text("changed")
            with self.assertRaisesRegex(ValueError, "digest"):
                seed_images(source, document, 1)
