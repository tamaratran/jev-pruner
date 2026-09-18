import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from evals.full import save
from evals.modal_runner import campaign_order, preflight_manifest, seed_images


class CampaignTests(unittest.TestCase):
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
