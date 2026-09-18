import unittest
from unittest.mock import patch

from evals import test_modal_parallel
from evals.modal_runner import eligible_rows, select_candidate


class RefreshRefillTests(unittest.IsolatedAsyncioTestCase):
    def test_safe_candidates_precede_exclusive_trials_without_dropping_them(self):
        rows = [
            {"task": task, "arm": "control", "state": "pending"}
            for task in ("long", "short", "other")
        ]
        specs = {
            task: {
                "build_seconds": 10,
                "preflight_lifetime_seconds": 100,
                "full_lifetime_seconds": duration,
            }
            for task, duration in (("long", 3600), ("short", 100), ("other", 100))
        }
        with patch("evals.modal_runner.time.time", return_value=1000):
            self.assertEqual(
                select_candidate(rows, specs, 2_800_000, set()), (rows[1], False)
            )
            self.assertEqual(
                select_candidate(rows, specs, 2_800_000, {"short"}),
                (rows[2], False),
            )
            self.assertEqual(
                select_candidate(rows, specs, 2_800_000, {"short", "other"}),
                (rows[0], True),
            )
            self.assertEqual(
                select_candidate(rows, specs, 1_000_000, set()), (rows[0], True)
            )
            self.assertEqual(
                select_candidate(rows, specs, None, set()), (rows[0], False)
            )
            self.assertEqual(
                select_candidate(rows, specs, 2_800_000, set(specs)), (None, False)
            )

    def test_authentication_recheck_remains_an_exclusive_barrier(self):
        rows = [
            {"task": task, "arm": "control", "state": "pending"} for task in ("a", "b")
        ]
        setups = [
            {"task": "a", "arm": "preflight", "state": "finished"},
            {
                "task": "b",
                "arm": "preflight",
                "state": "pending",
                "subscription_recheck": True,
            },
        ]
        candidates = eligible_rows(rows, setups)
        self.assertEqual(
            select_candidate(candidates, {}, None, set()), (setups[1], True)
        )

    async def test_short_work_refills_while_a_long_trial_waits_for_exclusivity(self):
        fixture = test_modal_parallel.ParallelTests(
            "test_free_slots_refill_while_a_slow_trial_runs"
        )
        with patch(
            "evals.modal_runner.fits_before_refresh",
            side_effect=lambda spec, preflight, expiry: preflight
            or spec["task"] != "b",
        ):
            await fixture.exercise_wave(False, tasks=("a", "b", "c", "d"))
