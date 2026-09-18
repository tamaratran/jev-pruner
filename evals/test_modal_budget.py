import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from harbor.models.registry import DatasetSpec
from harbor.models.task.config import TaskConfig

from evals.modal_budget import main, prepare, task_estimate


class ModalBudgetTests(unittest.TestCase):
    def config(self, **environment: object) -> TaskConfig:
        return TaskConfig.model_validate(
            {
                "environment": {"cpus": 2, "memory": "4G", **environment},
                "agent": {"timeout_sec": 900},
                "verifier": {"timeout_sec": 600},
            }
        )

    def test_legacy_memory_and_all_phases_use_sandbox_prices(self) -> None:
        estimate = task_estimate(self.config())
        self.assertEqual(estimate["total_seconds"], 3000)
        self.assertAlmostEqual(
            estimate["declared_resource_usd"],
            3000 * (2 * 0.00003942 + 4 * 0.00000667),
        )

    def test_unknown_resources_and_unbounded_timeouts_are_not_zero_cost(self) -> None:
        for change in ({"cpus": None}, {"memory": None}, {"gpus": 1}, {"cpus": 0}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                task_estimate(self.config(**change))
        for timeout in (None, float("inf"), float("nan"), -1, 0):
            config = self.config()
            config.agent.timeout_sec = timeout
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                task_estimate(config)

    def dataset(self, path: str = "one", commit: str = "a" * 40) -> DatasetSpec:
        return DatasetSpec.model_validate(
            {
                "name": "terminal-bench",
                "version": "2.0",
                "description": "",
                "tasks": [
                    {
                        "name": "one",
                        "path": path,
                        "git_url": "https://example.invalid/tasks.git",
                        "git_commit_id": commit,
                    }
                ],
            }
        )

    def test_exclusions_keep_both_unscored_rows_and_separate_budget(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            task = source / "one"
            task.mkdir()
            (task / "task.toml").write_text(
                '[environment]\ncpus=2\nmemory="4G"\n[agent]\ntimeout_sec=900\n'
            )
            with patch(
                "evals.modal_budget.subprocess.check_output",
                side_effect=["a" * 40, b"", "b" * 40],
            ):
                result = prepare(
                    self.dataset(), source, {"one": "scope restriction"}, 0.01
                )
            self.assertEqual(result["expected_trials"], 2)
            self.assertEqual(result["excluded_tasks"], 1)
            self.assertEqual(result["budget"]["eligible_declared_resource_usd"], 0)
            self.assertFalse(result["budget"]["full_planning_estimate_fits"])
            self.assertFalse(result["budget"]["enforceable_billing_cap"])
            for row in result["manifest"]:
                self.assertEqual(row["state"], "excluded")
                self.assertIsNone(row["reward"])

    def test_unpinned_or_escaping_paths_are_rejected(self) -> None:
        for dataset in (
            self.dataset(commit="c" * 40),
            self.dataset(path="../outside"),
            self.dataset(path="/outside"),
        ):
            with (
                patch(
                    "evals.modal_budget.subprocess.check_output",
                    side_effect=["a" * 40, b""],
                ),
                self.assertRaises(ValueError),
            ):
                prepare(dataset, Path("/source"), {}, 30)

    def test_dirty_sources_are_rejected(self) -> None:
        with (
            patch(
                "evals.modal_budget.subprocess.check_output",
                side_effect=["a" * 40, b" M one/task.toml"],
            ),
            self.assertRaisesRegex(ValueError, "clean"),
        ):
            prepare(self.dataset(), Path("/source"), {}, 30)

    def test_invalid_budget_and_unknown_exclusions_are_rejected(self) -> None:
        for budget in (0, -1, float("nan"), float("inf")):
            with self.subTest(budget=budget), self.assertRaises(ValueError):
                prepare(self.dataset(), Path("/source"), {}, budget)
        with self.assertRaisesRegex(ValueError, "unknown"):
            prepare(self.dataset(), Path("/source"), {"typo": "reason"}, 30)

    def test_cli_rejects_changed_registry_before_creating_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry = root / "registry.json"
            registry.write_text("[]")
            output = root / "plan.json"
            with (
                patch(
                    "sys.argv",
                    [
                        "modal_budget",
                        str(output),
                        "--registry",
                        str(registry),
                        "--benchmark-source",
                        str(root),
                        "--exclusions",
                        str(root / "unused.json"),
                    ],
                ),
                self.assertRaisesRegex(ValueError, "immutable registry"),
            ):
                main()
            self.assertFalse(output.exists())
