"""Offline planning, approval-gated Modal preflight, and serial matched trials."""

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import math
import os
import shutil
import subprocess
import time
import tomllib
from pathlib import Path

from harbor.models.task.config import TaskConfig
from harbor.models.trial.config import (
    AgentConfig,
    EnvironmentConfig,
    ResourceMode,
    TaskConfig as TrialTaskConfig,
    TrialConfig,
)
from harbor.models.trial.paths import TrialPaths
from harbor.trial.trial import Trial

from evals.auth import AUTH_OVERRIDES, subscription_source
from evals.full import (
    MODEL,
    REGISTRY,
    REPO,
    access_blocker,
    checkpoint,
    failure_category,
    save,
    source_hashes,
)
from evals.modal_images import resolve_image
from evals.modal_provider import (
    CLEANUP_SECONDS,
    TRANSFER_SECONDS,
    PinnedModalEnvironment,
)
from evals.summarize import read_events, summarize_trial

PRODUCTION_REVISION = "907353b80f159bd3d693d6fbb310b1f6bf10c2d3"
BENCHMARK_REVISION = "69671fbaac6d67a7ef0dfec016cc38a64ef7a77c"
PACKAGES = {"harbor": "0.22.0", "modal": "1.5.1", "dockerfile-parse": "2.0.1"}
CPU_RATE = 0.00003942
RAM_RATE = 0.00000667
BUILDER = "2025.06"


def git(root: Path, *arguments: str) -> str:
    return subprocess.check_output(["git", *arguments], cwd=root, text=True).strip()


def task_hashes(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for task in sorted(root.glob("*/task.toml"))
        for path in sorted(task.parent.rglob("*"))
        if path.is_file()
    }


def provenance(benchmark: Path) -> dict:
    if git(benchmark, "rev-parse", "HEAD") != BENCHMARK_REVISION:
        raise ValueError("Terminal-Bench revision differs from the frozen run")
    if git(REPO, "status", "--porcelain") or git(benchmark, "status", "--porcelain"):
        raise ValueError("Commit sources and use a clean benchmark checkout")
    packages = {name: importlib.metadata.version(name) for name in PACKAGES}
    if packages != PACKAGES:
        raise ValueError("Use the exact Harbor/Modal dependency versions")
    production = {}
    names = git(REPO, "ls-files", ".claude-plugin", "hooks", "src").splitlines()
    frozen_names = git(
        REPO,
        "ls-tree",
        "-r",
        "--name-only",
        PRODUCTION_REVISION,
        "--",
        ".claude-plugin",
        "hooks",
        "src",
    ).splitlines()
    if names != frozen_names:
        raise ValueError("Production file inventory changed")
    for name in names:
        frozen = subprocess.check_output(
            ["git", "show", f"{PRODUCTION_REVISION}:{name}"], cwd=REPO
        )
        if (REPO / name).read_bytes() != frozen:
            raise ValueError(f"Production drift: {name}")
        production[name] = hashlib.sha256(frozen).hexdigest()
    return {
        "commit": git(REPO, "rev-parse", "HEAD"),
        "sources": source_hashes(),
        "production_revision": PRODUCTION_REVISION,
        "production_sha256": production,
        "benchmark_revision": BENCHMARK_REVISION,
        "registry": REGISTRY,
        "task_sha256": task_hashes(benchmark),
        "packages": packages,
        "image_builder": BUILDER,
        "model": MODEL,
        "claude_version": "2.1.274",
        "high_effort": True,
        "max_turns": 80,
        "model_price_guard_usd": 3,
        "subscription_billing_usd": None,
        "jev_price_usd": None,
    }


def task_spec(path: Path) -> dict:
    task = TaskConfig.model_validate(tomllib.loads(path.read_text()))
    config = task.environment
    if (
        config.docker_image is None
        or config.os.value != "linux"
        or config.gpus
        or config.network_mode.value != "public"
        or task.agent.network_mode is not None
        or task.verifier.network_mode is not None
        or task.agent.user is not None
        or task.verifier.user is not None
    ):
        raise ValueError("Task differs from the audited public Linux profile")
    rate = config.cpus * CPU_RATE + config.memory_mb / 1024 * RAM_RATE
    overhead = 360 + TRANSFER_SECONDS + CLEANUP_SECONDS + 60
    return {
        "task": path.parent.name,
        "image": config.docker_image,
        "environment": config.model_dump(mode="json"),
        "cpu": config.cpus,
        "memory_mib": config.memory_mb,
        "declared_storage_mib": config.storage_mb,
        "modal_storage_request": None,
        "agent_seconds": task.agent.timeout_sec,
        "verifier_seconds": task.verifier.timeout_sec,
        "build_seconds": config.build_timeout_sec,
        "preflight_lifetime_seconds": overhead,
        "full_lifetime_seconds": math.ceil(
            overhead + task.agent.timeout_sec + task.verifier.timeout_sec
        ),
        "runtime_usd_per_second": rate,
    }


def trial_config(
    root: Path, benchmark: Path, row: dict, spec: dict, pin: dict, approved: bool
) -> TrialConfig:
    preflight = row["arm"] == "preflight"
    return TrialConfig(
        task=TrialTaskConfig(path=benchmark / row["task"]),
        trial_name=row["job_name"],
        trials_dir=root / "trials",
        install_only=preflight,
        agent=AgentConfig(
            import_path=(
                "evals.modal_preflight:ModalPreflightAgent"
                if preflight
                else "evals.harbor_agent:JevClaudeCode"
            ),
            model_name=MODEL,
            kwargs={
                "version": "2.1.274",
                "max_budget_usd": 3,
                "max_turns": 80,
                "reasoning_effort": "high",
            },
        ),
        environment=EnvironmentConfig(
            import_path="evals.modal_provider:PinnedModalEnvironment",
            cpu_enforcement_policy=ResourceMode.GUARANTEE,
            memory_enforcement_policy=ResourceMode.GUARANTEE,
            kwargs={
                "image_pin": pin,
                "approved": approved,
                "preflight": preflight,
                "sandbox_timeout_secs": spec[
                    "preflight_lifetime_seconds"
                    if preflight
                    else "full_lifetime_seconds"
                ],
            },
        ),
    )


def plan(root: Path, benchmark: Path) -> None:
    pin = provenance(benchmark)
    specs = [task_spec(path) for path in sorted(benchmark.glob("*/task.toml"))]
    if len(specs) != 89:
        raise ValueError("Expected all 89 Terminal-Bench tasks")
    if root.exists():
        raise ValueError("Use a fresh plan directory")
    rows = []
    for index, spec in enumerate(specs):
        for arm in ("control", "plugin") if index % 2 == 0 else ("plugin", "control"):
            rows.append(
                {
                    "task": spec["task"],
                    "arm": arm,
                    "job_name": f"{spec['task']}-{arm}",
                    "state": "pending",
                    "reward": None,
                }
            )
        task = TaskConfig.model_validate(
            tomllib.loads((benchmark / spec["task"] / "task.toml").read_text())
        )
        env = PinnedModalEnvironment(
            environment_dir=benchmark / spec["task"] / "environment",
            environment_name=spec["task"],
            session_id=f"offline-{spec['task']}",
            trial_paths=TrialPaths(trial_dir=root / "unused"),
            task_env_config=task.environment,
            image_pin={},
            cpu_enforcement_policy=ResourceMode.GUARANTEE,
            memory_enforcement_policy=ResourceMode.GUARANTEE,
        )
        if env._cpu_config() != (spec["cpu"], spec["cpu"]) or env._memory_config() != (
            spec["memory_mib"],
            spec["memory_mib"],
        ):
            raise ValueError("Provider resource mapping changed")
    root.mkdir(parents=True, mode=0o700)
    save(root / "plan.json", {"provenance": pin, "tasks": specs, "trials": rows})
    print(
        f"Offline plan: 89 task configurations, 178 rows; no Modal resources created: {root}"
    )


def budget_reservation(spec: dict, preflight: bool, build_reserve: float) -> float:
    lifetime = spec[
        "preflight_lifetime_seconds" if preflight else "full_lifetime_seconds"
    ]
    return spec["runtime_usd_per_second"] * (lifetime + spec["build_seconds"]) + (
        build_reserve if preflight else 0
    )


def ensure_budget(ledger: dict, reserve: float) -> None:
    if ledger["unreconciled_import"]:
        raise ValueError("Reconcile observed Modal usage before another image import")
    if ledger["accounted_usd"] + reserve > ledger["budget_usd"]:
        raise ValueError("Next sandbox reservation exceeds approved credit budget")


def load(path: Path) -> dict:
    return json.loads(path.read_text())


async def execute(args: argparse.Namespace) -> None:
    preflight = args.command == "preflight"
    if not args.approve_modal_compute or (not preflight and not args.approve_inference):
        raise ValueError("Explicit separate compute/inference approval flags required")
    if not math.isfinite(args.budget_usd) or args.budget_usd <= 0:
        raise ValueError("Positive finite credit budget required")
    if preflight and (
        not math.isfinite(args.build_reserve_usd) or args.build_reserve_usd <= 0
    ):
        raise ValueError(
            "Explicit positive planning reserve for unmetered image imports required"
        )
    root, benchmark = args.evidence.resolve(), args.benchmark_source.resolve()
    if root.is_relative_to(REPO):
        raise ValueError("Evidence must be outside the repository")
    document = load(args.plan / "plan.json")
    if document["provenance"] != provenance(benchmark):
        raise ValueError(
            "Plan provenance mismatch; do not resume with changed sources/tasks"
        )
    if os.environ.get("JEV_EVAL_AUTH_MODE") != "subscription":
        raise ValueError("Explicit subscription authentication required")
    os.environ["EVIDENCE_DIR"] = str(root)
    subscription_source()
    for name in AUTH_OVERRIDES:
        os.environ.pop(name, None)
    os.environ["MODAL_IMAGE_BUILDER_VERSION"] = BUILDER
    if not preflight and (
        not os.environ.get("TYPESAFE_API_KEY")
        or os.environ["TYPESAFE_API_KEY"].startswith("secret:")
    ):
        raise ValueError("Inject Jev key before full execution")
    identity = {
        "plan_sha256": hashlib.sha256(
            (args.plan / "plan.json").read_bytes()
        ).hexdigest(),
        "mode": args.command,
        "budget_usd": args.budget_usd,
        "build_reserve_usd": args.build_reserve_usd if preflight else 0,
    }
    if root.exists():
        if not args.resume or load(root / "identity.json") != identity:
            raise ValueError(
                "Refusing reused evidence directory or mismatched resume identity"
            )
        rows = json.loads((root / "progress.json").read_text())
        ledger = load(root / "budget.json")
        if any(row["state"] not in {"pending", "finished"} for row in rows):
            raise ValueError("Interrupted/failed attempts cannot be silently resumed")
        if args.observed_total_usd is not None:
            observed = args.observed_total_usd
            if not math.isfinite(observed) or observed < 0:
                raise ValueError(
                    "Observed cumulative Modal usage must be nonnegative and finite"
                )
            ledger["reconciliations"].append(
                {
                    "time": time.time(),
                    "observed_total_usd": observed,
                    "source": "Operator reading of attributable Modal compute usage including credits",
                }
            )
            ledger["accounted_usd"] = max(observed, ledger["accounted_usd"])
            ledger["unreconciled_import"] = False
            save(root / "budget.json", ledger)
    else:
        if args.resume or args.observed_total_usd is not None:
            raise ValueError("Resume requires a completed checkpoint")
        root.mkdir(parents=True, mode=0o700)
        save(root / "identity.json", identity)
        save(root / "provenance.json", document["provenance"])
        rows = (
            [
                {
                    "task": spec["task"],
                    "arm": "preflight",
                    "job_name": f"{spec['task']}-preflight",
                    "state": "pending",
                    "reward": None,
                }
                for spec in document["tasks"]
            ]
            if preflight
            else document["trials"]
        )
        ledger = {
            "budget_usd": args.budget_usd,
            "accounted_usd": 0.0,
            "unreconciled_import": False,
            "reconciliations": [],
            "entries": [],
            "actual_image_build_usd": None,
            "actual_subscription_billing_usd": None,
            "jev_cost_usd": None,
            "note": "Reservations are estimates, not a billing cap. Image import/build spend is unknown until observed; SDK billing is not metered here.",
        }
        save(root / "budget.json", ledger)
    if preflight:
        images = load(root / "images.json") if (root / "images.json").exists() else {}
    else:
        previous = load(args.preflight / "identity.json")
        if previous["plan_sha256"] != identity["plan_sha256"]:
            raise ValueError("Preflight uses another plan")
        preflight_rows = json.loads((args.preflight / "progress.json").read_text())
        if len(preflight_rows) != 89 or any(
            row["state"] != "finished" for row in preflight_rows
        ):
            raise ValueError(
                "All 89 image/resource/auth preflights must pass before inference"
            )
        if load(args.preflight / "budget.json")["unreconciled_import"]:
            raise ValueError("Reconcile final preflight image cost before inference")
        images = load(args.preflight / "images.json")
        preflight_spend = load(args.preflight / "budget.json")["accounted_usd"]
        if "preflight_accounted_usd" not in ledger:
            ledger["preflight_accounted_usd"] = preflight_spend
            ledger["accounted_usd"] += preflight_spend
    specs = {spec["task"]: spec for spec in document["tasks"]}

    def persist() -> None:
        if preflight:
            save(root / "progress.json", rows)
            save(root / "images.json", images)
        else:
            checkpoint(root, rows)
        save(root / "budget.json", ledger)

    persist()
    for row in rows:
        if row["state"] == "finished":
            continue
        spec = specs[row["task"]]
        reserve = budget_reservation(spec, preflight, identity["build_reserve_usd"])
        ensure_budget(ledger, reserve)
        if shutil.disk_usage(root).free < 20 * 1024**3:
            raise ValueError("Less than 20 GiB free for local evidence")
        if document["provenance"] != provenance(benchmark):
            raise ValueError("Sources changed; stopping before another attempt")
        row["state"] = "resolving_image"
        persist()
        try:
            resolved = await asyncio.to_thread(resolve_image, spec["image"])
            if row["task"] in images:
                if resolved != {key: images[row["task"]][key] for key in resolved}:
                    raise ValueError("Mutable image tag changed after preflight")
                resolved = images[row["task"]]
            else:
                images[row["task"]] = resolved
            save(root / "resolved-images.json", images)
        except Exception as error:
            row.update(
                state="image_error",
                failure_category="infrastructure",
                error=type(error).__name__,
            )
            persist()
            return
        row.update(state="running", agent_attempts=0)
        ledger["accounted_usd"] += reserve
        ledger["unreconciled_import"] = preflight
        ledger["entries"].append(
            {
                "task": row["task"],
                "arm": row["arm"],
                "reserved_usd": reserve,
                "image_build_usd": None if preflight else 0,
            }
        )
        persist()
        os.environ["JEV_EVAL_ARM"] = "control" if preflight else row["arm"]
        config = trial_config(root, benchmark, row, spec, resolved, approved=True)
        trial = None
        try:
            trial = await Trial.create(config)
            bound = (
                spec["build_seconds"]
                + config.environment.kwargs["sandbox_timeout_secs"]
            )
            await asyncio.wait_for(trial.run(), timeout=bound)
        except BaseException as error:
            row.update(state="infrastructure_error", error=type(error).__name__)
        finally:
            if trial is not None:
                await trial.agent_environment.stop(delete=True)
        location = root / "trials" / row["job_name"]
        lifecycle = (
            load(location / "modal-lifecycle.json")
            if (location / "modal-lifecycle.json").exists()
            else {}
        )
        row["modal"] = lifecycle
        result_path = location / "result.json"
        try:
            if result_path.exists():
                result = load(result_path)
                row["agent_attempts"] = int(bool(result.get("agent_execution")))
                if preflight:
                    row["exception"] = result.get("exception_info")
                    row["state"] = "finished" if not row["exception"] else "setup_error"
                    settings = location / "agent/eval-settings.json"
                    if settings.exists():
                        row["auth_status"] = load(settings).get("auth_status")
                else:
                    row.update(summarize_trial(result_path), state="finished")
                    row["task_revision"] = BENCHMARK_REVISION
                    row["failure_category"] = failure_category(row)
        except (ValueError, KeyError, TypeError) as error:
            row.update(
                state="evidence_error",
                failure_category="infrastructure",
                error=type(error).__name__,
                reward=None,
            )
        required = ["agent/eval-settings.json"]
        required += (
            ["agent/modal-preflight.json"]
            if preflight
            else ["agent/claude-code.txt", "agent/jev/activated.json"]
        )
        missing = [name for name in required if not (location / name).is_file()]
        if not preflight and not any(
            (location / f"verifier/reward.{suffix}").is_file()
            for suffix in ("txt", "json")
        ):
            missing.append("verifier/reward")
        row["missing_evidence"] = missing
        if (
            missing
            or not lifecycle.get("evidence_verified")
            or not lifecycle.get("termination_confirmed")
        ):
            row["underlying_failure_category"] = row.get("failure_category")
            row.update(
                state="evidence_error", failure_category="infrastructure", reward=None
            )
        if preflight and row["state"] == "finished":
            images[row["task"]]["modal_image_id"] = lifecycle["modal_image_id"]
        if lifecycle.get("termination_confirmed"):
            estimate = lifecycle["elapsed_seconds"] * spec["runtime_usd_per_second"]
            build_margin = identity["build_reserve_usd"] if preflight else 0
            ledger["accounted_usd"] += estimate + build_margin - reserve
            ledger["entries"][-1]["runtime_estimate_usd"] = estimate
        persist()
        print(f"{row['task']} {row['arm']}: {row['state']}", flush=True)
        if preflight:
            print(
                "Stopped after one image. Reconcile observed Modal usage before resuming.",
                flush=True,
            )
            return
        if (
            row["state"] != "finished"
            or row.get("failure_category")
            in {"infrastructure", "agent_setup", "instrumentation"}
            or access_blocker(read_events(location / "agent/claude-code.txt"))
        ):
            return


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "preflight", "run"))
    parser.add_argument("--benchmark-source", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--preflight", type=Path)
    parser.add_argument("--budget-usd", type=float, default=0)
    parser.add_argument("--build-reserve-usd", type=float, default=0)
    parser.add_argument("--approve-modal-compute", action="store_true")
    parser.add_argument("--approve-inference", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--observed-total-usd", type=float)
    args = parser.parse_args()
    if args.command == "plan":
        plan(args.plan.resolve(), args.benchmark_source.resolve())
    else:
        if args.evidence is None or (args.command == "run" and args.preflight is None):
            parser.error("--evidence required; run also requires --preflight")
        asyncio.run(execute(args))


if __name__ == "__main__":
    main()
