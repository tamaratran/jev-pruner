import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from evals.full import continuation_rows


class ContinuationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.manifest = [
            {"task": "one", "arm": arm, "job_name": arm, "resource_blocked": False}
            for arm in ("control", "plugin")
        ]
        self.pin = {"hooks/production.ts": "unchanged", "evals/observer.ts": "old"}
        self.flags = ["--model", "pinned", "--env", "modal"]
        self.write(
            "execution-provenance.json",
            {
                "source_sha256": self.pin,
                "flags": self.flags,
                "commit": "original",
            },
        )
        self.rows = [
            {**self.manifest[0], "state": "finished", "reward": 1},
            {**self.manifest[1], "state": "pending"},
        ]
        self.write("progress.json", self.rows)

    def write(self, name: str, value: object) -> None:
        (self.root / name).write_text(json.dumps(value))

    def test_instrumentation_fix_preserves_completed_trial_and_pending_order(
        self,
    ) -> None:
        pin = {**self.pin, "evals/observer.ts": "fixed"}
        rows = continuation_rows(self.root, self.manifest, self.flags, pin)
        self.assertEqual(rows[0]["reward"], 1)
        self.assertEqual(rows[0]["state"], "finished")
        self.assertEqual(rows[0]["execution_commit"], "original")
        self.assertEqual(rows[1], self.rows[1])
        self.assertEqual(
            json.loads((self.root / "progress.json").read_text()), self.rows
        )

    def test_protocol_and_production_changes_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "trial flags"):
            continuation_rows(self.root, self.manifest, ["different"], self.pin)
        with self.assertRaisesRegex(ValueError, "production sources"):
            continuation_rows(
                self.root,
                self.manifest,
                self.flags,
                {**self.pin, "hooks/production.ts": "different"},
            )
        with self.assertRaisesRegex(ValueError, "manifest"):
            continuation_rows(
                self.root, list(reversed(self.manifest)), self.flags, self.pin
            )

    def test_plugin_option_changes_are_rejected(self) -> None:
        with patch("evals.full.plugin_options", return_value={"chunkChars": 4000}):
            with self.assertRaisesRegex(ValueError, "plugin options"):
                continuation_rows(self.root, self.manifest, self.flags, self.pin)

    def test_running_trial_is_never_retried(self) -> None:
        self.rows[0]["state"] = "running"
        self.write("progress.json", self.rows)
        with self.assertRaisesRegex(ValueError, "unfinished Harbor"):
            continuation_rows(self.root, self.manifest, self.flags, self.pin)

    def test_completed_harbor_evidence_recovers_interrupted_checkpoint(self) -> None:
        self.rows[0]["state"] = "running"
        self.write("progress.json", self.rows)
        trial = self.root / "jobs/control/trial/result.json"
        trial.parent.mkdir(parents=True)
        trial.write_text("{}")
        self.write("jobs/control/result.json", {"finished_at": "2026-09-18T10:00:00Z"})
        with patch(
            "evals.full.summarize_trial", return_value={"reward": 1}
        ) as summarize:
            rows = continuation_rows(self.root, self.manifest, self.flags, self.pin)
        summarize.assert_called_once_with(trial)
        self.assertEqual(rows[0]["state"], "finished")
        self.assertTrue(rows[0]["recovered_from_completed_harbor_job"])
        self.assertIsNone(rows[0]["harbor_return_code"])
        self.assertEqual(rows[1]["state"], "pending")
