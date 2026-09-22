"""Compare the pilot subset or every pinned CompileBench task."""

import argparse
import hashlib
import json
import shutil
from datetime import UTC, datetime
from pathlib import Path

from evals.capture_pilot import digest, task_hashes
from evals.codex_bench import FLAGS, git, run, source_hashes
from evals.full import save
from evals.harbor_codex import INSTRUCTIONS, REPO
from evals.standardized_codex import SETTINGS

TASKS = ("cowsay", "coreutils", "jq", "curl-ssl")
REVISION = "66e27468505706643088b79f8efad6260c274dc5"


def plan(
    root: Path,
    benchmark: Path,
    replay: Path,
    concurrency: int,
    *,
    full: bool = False,
    docker_tasks: tuple[str, ...] = (),
    repetitions: int | None = None,
    seed: str | None = None,
    model_catalog: Path | None = None,
) -> None:
    if root.exists():
        raise ValueError("Use a fresh evidence directory")
    if git(REPO, "status", "--porcelain") or git(benchmark, "status", "--porcelain"):
        raise ValueError("Commit sources and use a clean benchmark checkout")
    if git(benchmark, "rev-parse", "HEAD") != REVISION:
        raise ValueError("CompileBench revision differs from the capture pilot")
    gate = json.loads((replay / "gate.json").read_text())
    if gate.get("passed") is not True or gate.get("replayed") != 4:
        raise ValueError("A completed, passing four-output replay is required")
    replay_protocol = json.loads((replay / "protocol.json").read_text())
    for name, expected in replay_protocol["source_sha256"].items():
        if digest(REPO / name) != expected:
            raise ValueError(f"Source changed since replay: {name}")
    tasks = (
        tuple(
            sorted(
                path.name
                for path in (benchmark / "datasets/compilebench").iterdir()
                if (path / "task.toml").is_file()
            )
        )
        if full
        else TASKS
    )
    if full and len(tasks) != 15:
        raise ValueError("Expected all 15 tasks at the pinned revision")
    if set(docker_tasks) - set(tasks):
        raise ValueError("Docker tasks must belong to the selected suite")
    repetitions = repetitions if repetitions is not None else (1 if full else 3)
    if repetitions < 1:
        raise ValueError("At least one repetition is required")
    if (seed is None) != (model_catalog is None):
        raise ValueError("Standardized plans require both seed and model catalog")
    if model_catalog is not None:
        catalog = json.loads(model_catalog.read_text())
        models = [model for model in catalog["models"] if model["slug"] == "gpt-5.5"]
        if len(models) != 1:
            raise ValueError("Catalog must contain exactly one gpt-5.5 definition")
    flags = ["-p", str(root / "tasks"), *FLAGS[FLAGS.index("-a") :]]
    if seed is not None:
        flags[flags.index("-a") + 1] = "evals.standardized_codex:StandardizedCodex"
    docker_flags = [*flags[: flags.index("--env")], "--env", "docker"]
    root.mkdir(mode=0o700)
    standardization = None
    if model_catalog is not None:
        save(root / "models.json", {"models": models})
        standardization = {
            "schema": 1,
            "seed": seed,
            "catalog_sha256": digest(root / "models.json"),
            "codex_settings": SETTINGS,
            "request_comparison": "Full initial JSON request, excluding cache key and explicitly listed transport IDs/timestamps in codex_start.mjs; all instructions, input content, tools and model settings are compared unchanged.",
            "runtime_comparison": "Initial workspace contents, modes and symlinks; OS package inventory; tool binary hashes; Codex config, catalog, arguments and selected environment variables.",
            "reference_policy": "First arm supplies a per-pair reference. The other arm must match before inference is forwarded. Both remain provisional until the pair audit passes.",
        }
    rows = []
    selected = []
    task_flags = {}
    serial_tasks = []
    for repetition in range(1, repetitions + 1):
        for index, source in enumerate(tasks):
            task = f"{source}-r{repetition}"
            selected.append(task)
            if source in docker_tasks:
                task_flags[task] = docker_flags
                serial_tasks.append(task)
            shutil.copytree(
                benchmark / "datasets/compilebench" / source, root / "tasks" / task
            )
            arms = (
                ("control", "plugin")
                if (index + repetition) % 2
                else ("plugin", "control")
            )
            if seed is not None:
                order = hashlib.sha256(f"{seed}:arm:{source}".encode()).digest()[0]
                arms = (
                    ("control", "plugin")
                    if (order + repetition) % 2
                    else ("plugin", "control")
                )
            for arm in arms:
                rows.append(
                    {
                        "task": task,
                        "source_task": source,
                        "repetition": repetition,
                        "arm": arm,
                        "job_name": f"{task}-{arm}",
                        "state": "pending",
                    }
                )
    if seed is not None:
        selected.sort(
            key=lambda task: hashlib.sha256(f"{seed}:schedule:{task}".encode()).digest()
        )
        rows.sort(key=lambda row: selected.index(str(row["task"])))
    save(
        root / "protocol.json",
        {
            "created_at": datetime.now(UTC).isoformat(),
            "benchmark": "CompileBench full suite"
            if full
            else "CompileBench Linux subset",
            "benchmark_revision": REVISION,
            "local_task_root": str(root / "tasks"),
            "task_sha256": task_hashes(root),
            "selected_tasks": selected,
            "distinct_tasks": list(tasks),
            "selection": (
                "Every task directory at the pinned revision, with no exclusions."
                if full
                else "All four Linux tasks from the capture pilot, including unchanged outputs. jq-windows remains excluded for its separately recorded Wine verifier failure."
            ),
            "commit": git(REPO, "rev-parse", "HEAD"),
            "source_sha256": source_hashes(),
            "replay_results_sha256": digest(replay / "results.json"),
            "flags": flags,
            "task_flags": task_flags,
            "serial_tasks": serial_tasks,
            "environment_policy": "Modal by default; explicitly selected Docker task pairs share one local worker. Both arms use the same environment.",
            "instructions": INSTRUCTIONS,
            "concurrency": concurrency,
            "repetitions": repetitions,
            "attempts": len(rows),
            "arm_order": (
                "Seeded first arm per source task; reversed on alternating repetitions; sequential within each pair."
                if seed is not None
                else "Alternating across tasks and repetitions; sequential within each pair."
            ),
            "standardization": standardization,
            "schedule": (
                "Seeded SHA256 task/repetition order and seeded first arm per source task, reversed on alternating repetitions; sequential within each pair."
                if seed is not None
                else "Legacy alternating schedule"
            ),
            "retries": 0,
            "modal_image_builder_version": "2025.06",
            "rates_per_million": {
                "input": 5,
                "output": 30,
                "jev_input": 0.042,
                "cached_secondary": 0.5,
            },
            "primary_cost": "All model input * 5/M + output * 30/M + Jev input * 0.042/M.",
            "scope": (
                f"Full task coverage at the pinned revision, {repetitions} attempt(s) per arm per task. The suite includes related variants of the same projects."
                if full
                else "Exploratory repeated subset selected after observing capture opportunities; not an unseen or full benchmark result."
            ),
            "inclusion": f"All {len(rows)} attempts retained. Effectiveness requires both measurements valid and actual pruning; no reward-based exclusions. A task alias identifies one repetition, not a distinct benchmark task.",
        },
    )
    save(root / "progress.json", rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["plan", "run"])
    parser.add_argument("root", type=Path)
    parser.add_argument("--benchmark", type=Path)
    parser.add_argument("--replay", type=Path)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--docker-task", action="append", default=[])
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--seed", default="jev-standardized-compilebench-v1")
    parser.add_argument("--model-catalog", type=Path)
    parser.add_argument("--harbor", default="harbor")
    args = parser.parse_args()
    root = args.root.resolve()
    if root.is_relative_to(REPO) or not 1 <= args.concurrency <= 16:
        parser.error("Use external evidence and 1–16 workers")
    if args.action == "plan":
        if args.benchmark is None or args.replay is None or args.model_catalog is None:
            parser.error("--benchmark, --replay and --model-catalog are required")
        plan(
            root,
            args.benchmark.resolve(),
            args.replay.resolve(),
            args.concurrency,
            full=args.full,
            docker_tasks=tuple(args.docker_task),
            repetitions=args.repetitions,
            seed=args.seed,
            model_catalog=args.model_catalog.resolve(),
        )
    else:
        protocol = json.loads((root / "protocol.json").read_text())
        if task_hashes(root) != protocol["task_sha256"]:
            raise ValueError("Task files differ from the frozen protocol")
        run(root, args.harbor)


if __name__ == "__main__":
    main()
