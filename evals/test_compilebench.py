import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from evals.compilebench import REVISION, TASKS, plan


class CompileBenchPlanTests(unittest.TestCase):
    def test_pairs_copy_verifiers_and_reverse_order_between_repetitions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            benchmark, replay = root / "benchmark", root / "replay"
            for name in TASKS:
                folder = benchmark / "datasets" / "compilebench" / name
                folder.mkdir(parents=True)
                (folder / "test.sh").write_text(f"verify-{name}\n")
            replay.mkdir()
            (replay / "protocol.json").write_text('{"source_sha256":{}}')
            (replay / "results.json").write_text("[]")
            gate = replay / "gate.json"
            gate.write_text('{"passed":false,"replayed":4}')

            def git_result(_root: Path, *args: str) -> str:
                return REVISION if args == ("rev-parse", "HEAD") else ""

            with (
                patch("evals.compilebench.git", side_effect=git_result),
                patch("evals.compilebench.source_hashes", return_value={}),
            ):
                with self.assertRaisesRegex(ValueError, "passing four-output"):
                    plan(root / "run", benchmark, replay, 4)
                gate.write_text('{"passed":true,"replayed":4}')
                plan(root / "run", benchmark, replay, 4)
            rows = json.loads((root / "run/progress.json").read_text())
            self.assertEqual(len({row["job_name"] for row in rows}), 24)
            for name in TASKS:
                previous = None
                for repetition in range(1, 4):
                    task = f"{name}-r{repetition}"
                    pair = [row for row in rows if row["task"] == task]
                    self.assertEqual(
                        {row["arm"] for row in pair}, {"control", "plugin"}
                    )
                    if previous is not None:
                        self.assertNotEqual(pair[0]["arm"], previous)
                    previous = pair[0]["arm"]
                    self.assertEqual(
                        (root / "run/tasks" / task / "test.sh").read_text(),
                        f"verify-{name}\n",
                    )


if __name__ == "__main__":
    unittest.main()
