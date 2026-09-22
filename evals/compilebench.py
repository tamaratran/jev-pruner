"""Compare the pilot subset or every pinned CompileBench task."""

import argparse
import json
import shutil
from datetime import UTC, datetime
from pathlib import Path

from evals.capture_pilot import digest, task_hashes
from evals.codex_bench import FLAGS, git, run, source_hashes
from evals.full import save
from evals.harbor_codex import INSTRUCTIONS, REPO

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
    repetitions = 1 if full else 3
    flags = ["-p", str(root / "tasks"), *FLAGS[FLAGS.index("-a") :]]
    docker_flags = [*flags[: flags.index("--env")], "--env", "docker"]
    root.mkdir(mode=0o700)
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
            "arm_order": "Alternating across tasks and repetitions; sequential within each pair.",
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
                "Full task coverage at the pinned revision, one attempt per arm; not a repeated-trial estimate. The suite includes related variants of the same projects."
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
    parser.add_argument("--harbor", default="harbor")
    args = parser.parse_args()
    root = args.root.resolve()
    if root.is_relative_to(REPO) or not 1 <= args.concurrency <= 16:
        parser.error("Use external evidence and 1–16 workers")
    if args.action == "plan":
        if args.benchmark is None or args.replay is None:
            parser.error("--benchmark and --replay are required")
        plan(
            root,
            args.benchmark.resolve(),
            args.replay.resolve(),
            args.concurrency,
            full=args.full,
            docker_tasks=tuple(args.docker_task),
        )
    else:
        protocol = json.loads((root / "protocol.json").read_text())
        if task_hashes(root) != protocol["task_sha256"]:
            raise ValueError("Task files differ from the frozen protocol")
        run(root, args.harbor)


if __name__ == "__main__":
    main()
