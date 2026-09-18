"""Prepare an offline paired manifest and a Modal Sandbox planning estimate."""

import argparse
import hashlib
import json
import math
import subprocess
import tomllib
from pathlib import Path

from harbor.models.registry import DatasetSpec, Registry
from harbor.models.task.config import TaskConfig

from evals.full import FLAGS, REGISTRY, REPO

CPU_SECOND_USD = 0.00003942
GIB_SECOND_USD = 0.00000667
REGISTRY_SHA256 = "da1446bce05eabbd72a25eb9eef5a2f5db94645ce88c28e2497581433b3d2e60"


def task_estimate(config: TaskConfig) -> dict:
    env = config.environment
    phases = {
        "build_allowance": env.build_timeout_sec,
        "setup_allowance": 600.0,
        "agent": config.agent.timeout_sec,
        "verifier": config.verifier.timeout_sec,
        "transfer_and_teardown_allowance": 300.0,
    }
    if env.cpus is None or env.memory_mb is None:
        raise ValueError("Explicit CPU and memory declarations are required")
    if env.cpus <= 0 or env.memory_mb <= 0 or env.gpus or env.tpu:
        raise ValueError("Only explicit positive CPU/memory, non-GPU tasks are priced")
    seconds = 0.0
    for value in phases.values():
        if value is None or not math.isfinite(value) or value <= 0:
            raise ValueError("Every phase needs a finite positive timeout/allowance")
        seconds += value
    rate = env.cpus * CPU_SECOND_USD + env.memory_mb / 1024 * GIB_SECOND_USD
    return {
        "phase_seconds": phases,
        "total_seconds": seconds,
        "declared_resource_usd": seconds * rate,
    }


def prepare(
    dataset: DatasetSpec,
    source: Path,
    exclusions: dict[str, str],
    budget_usd: float,
) -> dict:
    if not math.isfinite(budget_usd) or budget_usd <= 0:
        raise ValueError("Budget must be finite and positive")
    names = [task.name for task in dataset.tasks]
    if not names or len(set(names)) != len(names):
        raise ValueError("Task names must be nonempty and unique")
    if exclusions.keys() - set(names):
        raise ValueError("Exclusions contain unknown tasks")
    if any(
        not isinstance(reason, str) or not reason.strip()
        for reason in exclusions.values()
    ):
        raise ValueError("Every exclusion needs a reason")
    source = source.resolve()
    head = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
    ).strip()
    if subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"]):
        raise ValueError("Task checkout must be clean")
    tasks = []
    manifest = []
    for index, task in enumerate(sorted(dataset.tasks, key=lambda task: task.name)):
        if task.git_commit_id != head or not task.git_url:
            raise ValueError("Every registry task must match the pinned checkout")
        directory = (source / task.path).resolve()
        if not directory.is_relative_to(source) or directory == source:
            raise ValueError("Task path escapes the checkout")
        config_path = directory / "task.toml"
        if not config_path.resolve().is_relative_to(directory):
            raise ValueError("Task configuration escapes its task directory")
        config = TaskConfig.model_validate(tomllib.loads(config_path.read_text()))
        env = config.environment
        environment_files = sorted(
            path for path in (directory / "environment").rglob("*") if path.is_file()
        )
        compose = [
            str(path.relative_to(directory))
            for path in environment_files
            if path.name
            in (
                "docker-compose.yaml",
                "docker-compose.yml",
                "compose.yaml",
                "compose.yml",
            )
        ]
        tree = subprocess.check_output(
            ["git", "-C", str(source), "rev-parse", f"{head}:{task.path.as_posix()}"],
            text=True,
        ).strip()
        row = {
            "task": task.name,
            "git_url": task.git_url,
            "git_commit_id": task.git_commit_id,
            "path": task.path.as_posix(),
            "git_tree": tree,
            "task_config_sha256": hashlib.sha256(config_path.read_bytes()).hexdigest(),
            "resources": {
                "cpus": env.cpus,
                "memory_mb": env.memory_mb,
                "storage_mb": env.storage_mb,
                "gpus": env.gpus or 0,
            },
            "network": {
                "environment": env.model_dump(
                    mode="json", include={"network_mode", "allowed_hosts"}
                ),
                "agent": config.agent.model_dump(
                    mode="json", include={"network_mode", "allowed_hosts"}
                ),
                "verifier": config.verifier.model_dump(
                    mode="json", include={"network_mode", "allowed_hosts"}
                ),
            },
            "docker_image": env.docker_image,
            "image_digest_pinned": bool(
                env.docker_image and "@sha256:" in env.docker_image
            ),
            "compose_files": compose,
            "exclusion_reason": exclusions.get(task.name),
            "compatibility": "requires_runtime_validation",
            **task_estimate(config),
        }
        tasks.append(row)
        arms = ("control", "plugin") if index % 2 == 0 else ("plugin", "control")
        for arm in arms:
            manifest.append(
                {
                    "task": task.name,
                    "arm": arm,
                    "git_commit_id": head,
                    "git_tree": tree,
                    "state": "excluded"
                    if task.name in exclusions
                    else "awaiting_approval_and_validation",
                    "exclusion_reason": exclusions.get(task.name),
                    "reward": None,
                }
            )
    total = 2 * sum(task["declared_resource_usd"] for task in tasks)
    eligible = 2 * sum(
        task["declared_resource_usd"] for task in tasks if not task["exclusion_reason"]
    )
    return {
        "dataset": f"{dataset.name}@{dataset.version}",
        "registry_url": REGISTRY,
        "benchmark_commit": head,
        "settings": {
            "harbor": "0.22.0",
            "flags": FLAGS,
            "concurrency": 1,
            "retries": 0,
        },
        "expected_tasks": len(tasks),
        "expected_trials": len(manifest),
        "excluded_tasks": len(exclusions),
        "completed_trials": 0,
        "valid_trials": 0,
        "sandbox_pricing": {
            "source": "https://modal.com/pricing",
            "cpu_physical_core_second_usd": CPU_SECOND_USD,
            "memory_gib_second_usd": GIB_SECOND_USD,
        },
        "budget": {
            "available_usd": budget_usd,
            "full_declared_resource_usd": total,
            "full_with_25_percent_reserve_usd": total * 1.25,
            "eligible_declared_resource_usd": eligible,
            "eligible_with_25_percent_reserve_usd": eligible * 1.25,
            "full_planning_estimate_fits": total * 1.25 <= budget_usd,
            "enforceable_billing_cap": False,
            "actual_modal_usd": None,
        },
        "limitations": [
            "Planning only: this document is not an executable full-run manifest or launch approval.",
            "Build allowance is priced at task resources; actual builder resource ceilings are unverified.",
            "The 25% reserve is a planning assumption, not a bound on build or excess memory charges.",
            "Harbor Modal AUTO limits CPU but passes memory as a request; excess memory can be billed.",
            "Harbor's default sandbox lifetime is 24 hours; host cancellation is not proof of remote teardown.",
            "Task storage declarations are not passed to an explicit Modal disk setting.",
            "Registry image tags need resolved digests before claiming image-level reproducibility.",
            "Claude subscription charges, CLI list-price estimates and Jev usage are separate from Modal.",
        ],
        "tasks": tasks,
        "manifest": manifest,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--benchmark-source", type=Path, required=True)
    parser.add_argument("--exclusions", type=Path, required=True)
    parser.add_argument("--budget-usd", type=float, default=30)
    args = parser.parse_args()
    if not args.output.is_absolute() or args.output.resolve().is_relative_to(REPO):
        raise ValueError("Use an absolute output path outside the repository")
    registry_sha256 = hashlib.sha256(args.registry.read_bytes()).hexdigest()
    if registry_sha256 != REGISTRY_SHA256:
        raise ValueError("Registry bytes do not match the immutable registry pin")
    dataset = next(
        entry
        for entry in Registry.from_path(args.registry).datasets
        if entry.name == "terminal-bench" and entry.version == "2.0"
    )
    if len(dataset.tasks) != 89:
        raise ValueError("Expected the pinned 89-task dataset")
    result = prepare(
        dataset,
        args.benchmark_source,
        json.loads(args.exclusions.read_text()),
        args.budget_usd,
    )
    result["registry_sha256"] = registry_sha256
    result["planner_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    with args.output.open("x") as output:
        json.dump(result, output, indent=2)
        output.write("\n")
    print(f"Prepared {len(result['manifest'])} rows; no compute or inference started")


if __name__ == "__main__":
    main()
