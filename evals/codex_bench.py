"""Freeze and execute a reproducible Terminal-Bench subset without replacements."""

import argparse
import hashlib
import json
import os
import re
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

from evals.full import REGISTRY, save
from evals.harbor_codex import INSTRUCTIONS, MODEL, OVERRIDES, REPO, VERSION

PILOT = ["build-cython-ext", "chess-best-move", "configure-git-webserver"]
SEED = "jev-codex-terminal-bench-2-v1"
EXCLUSIONS = {
    "break-filter-js-from-html": "Creates an XSS filter bypass.",
    "crack-7z-hash": "Password cracking and secret recovery.",
    "feal-differential-cryptanalysis": "Recovers secret keys.",
    "feal-linear-cryptanalysis": "Recovers secret keys.",
    "git-leak-recovery": "Extracts a removed secret.",
    "password-recovery": "Recovers a deleted password.",
    "vulnerable-secret": "Extracts a secret from an executable.",
    "model-extraction-relu-logits": "Implements model weight extraction.",
    "sanitize-git-repo": "Requires credential discovery; omitted from this run.",
}
FLAGS = [
    "-d",
    "terminal-bench@2.0",
    "--registry-url",
    REGISTRY,
    "-a",
    "evals.harbor_codex:JevCodex",
    "-m",
    MODEL,
    "--ak",
    f"version={VERSION}",
    "--ak",
    "reasoning_effort=high",
    "-n",
    "1",
    "-k",
    "1",
    "-r",
    "0",
    "--timeout-multiplier",
    "1.0",
    "--env",
    "modal",
    "--ek",
    "app_name=jev-terminal-bench",
]


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


def hashes(root: Path, names: list[str]) -> dict[str, str]:
    return {
        name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in names
    }


def source_hashes() -> dict[str, str]:
    tracked = git(REPO, "ls-files", "evals", "src", "package-lock.json").splitlines()
    built = [
        str(path.relative_to(REPO)) for path in sorted((REPO / "dist").rglob("*.js"))
    ]
    if not built:
        raise ValueError("Build the production wrapper first")
    return hashes(REPO, tracked + built)


def plan(root: Path, benchmark: Path, phase: str, concurrency: int) -> None:
    if root.exists():
        raise ValueError("Use a fresh evidence directory")
    if root.is_relative_to(REPO) or not root.is_absolute():
        raise ValueError("Evidence must be absolute and outside the repository")
    if git(REPO, "status", "--porcelain") or git(benchmark, "status", "--porcelain"):
        raise ValueError("Commit sources and use an unmodified dataset checkout")
    names = sorted(
        path.name for path in benchmark.iterdir() if (path / "task.toml").is_file()
    )
    if len(names) != 89 or not set(EXCLUSIONS) <= set(names):
        raise ValueError("Expected the reviewed 89-task Terminal-Bench 2.0 dataset")
    eligible = [name for name in names if name not in EXCLUSIONS and name not in PILOT]
    selected = (
        PILOT
        if phase == "pilot"
        else sorted(
            eligible,
            key=lambda name: hashlib.sha256(f"{SEED}:{name}".encode()).hexdigest(),
        )[:32]
    )
    root.mkdir(parents=True, mode=0o700)
    rows = []
    for index, task in enumerate(selected):
        arms = ("control", "plugin") if index % 2 == 0 else ("plugin", "control")
        for arm in arms:
            rows.append(
                {
                    "task": task,
                    "arm": arm,
                    "state": "pending",
                    "job_name": f"{phase}-{task}-{arm}",
                }
            )
    task_files = git(benchmark, "ls-files", *selected).splitlines()
    protocol = {
        "created_at": datetime.now(UTC).isoformat(),
        "phase": phase,
        "selection_seed": SEED,
        "selected_tasks": selected,
        "task_selection": "pilot fixed historically; comparison first 32 SHA256(seed:name), excluding pilot and reviewed exclusions",
        "dataset_tasks": [
            {
                "task": name,
                "selected": name in selected,
                "exclusion": EXCLUSIONS.get(name),
            }
            for name in names
        ],
        "benchmark_commit": git(benchmark, "rev-parse", "HEAD"),
        "benchmark_sha256": hashes(benchmark, task_files),
        "commit": git(REPO, "rev-parse", "HEAD"),
        "source_sha256": source_hashes(),
        "flags": FLAGS,
        "instructions": INSTRUCTIONS,
        "concurrency": concurrency,
        "repetitions": 1,
        "arm_order": "alternating; arms within each pair sequential",
        "retries": 0,
        "modal_image_builder_version": "2025.06",
        "rates_per_million": {
            "input": 5,
            "output": 30,
            "cached_secondary": 0.5,
            "jev_input": 0.042,
        },
        "primary_cost": "all model input * 5/M + output * 30/M + Jev input * 0.042/M",
        "secondary_cost": "observed cache discount; reference estimates, not subscription charges",
        "inclusion": "All planned rows retained. Effectiveness requires both audited arms and actual shorter visible output; never filter on reward.",
    }
    save(root / "protocol.json", protocol)
    save(root / "progress.json", rows)


def access_blocked(job: Path) -> bool:
    for path in job.glob("*/agent/codex.txt"):
        for line in path.read_text().splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict) or event.get("type") not in (
                "error",
                "turn.failed",
            ):
                continue
            error = event if event["type"] == "error" else event.get("error")
            if not isinstance(error, dict):
                continue
            message = error.get("message")
            if not isinstance(message, str):
                continue
            if (
                message == "usage limit"
                or message.startswith(
                    (
                        "You've hit your usage limit.",
                        "You've hit your usage limit for ",
                        "rate limit exceeded: ",
                        "Quota exceeded. Check your plan and billing details.",
                        "To use Codex with your ChatGPT plan, upgrade to Plus:",
                        "Your access token could not be refreshed. Please log out and sign in again.",
                        "Your access token could not be refreshed because ",
                    )
                )
                or re.fullmatch(
                    r"(?:unexpected status |exceeded retry limit, last status: )"
                    r"(?:401 Unauthorized|429 Too Many Requests)(?:[:,] .*)?",
                    message,
                    re.DOTALL,
                )
                or re.fullmatch(
                    r"The '[^'\n]+' model is not supported when using Codex "
                    r"with a ChatGPT account\.",
                    message,
                )
            ):
                return True
    return False


def blocking_failure(job: Path) -> str | None:
    if access_blocked(job):
        return "Codex account or authentication error"
    results = list(job.glob("*/result.json"))
    if len(results) != 1:
        return "Missing or ambiguous Harbor trial result"
    trial = json.loads(results[0].read_text())
    if trial.get("exception_info") and not (trial.get("agent_execution") or {}).get(
        "started_at"
    ):
        return "Environment or agent setup failed before inference"
    return None


def run(root: Path, harbor: str) -> None:
    protocol = json.loads((root / "protocol.json").read_text())
    rows = json.loads((root / "progress.json").read_text())
    if any(row["state"] != "pending" for row in rows):
        raise ValueError("A started run cannot be restarted or silently retried")
    if (
        git(REPO, "status", "--porcelain")
        or source_hashes() != protocol["source_sha256"]
    ):
        raise ValueError("Sources differ from the frozen protocol")
    if subprocess.check_output([harbor, "--version"], text=True).strip() != "0.22.0":
        raise ValueError("Harbor 0.22.0 required")
    if not os.environ.get("TYPESAFE_API_KEY"):
        raise ValueError("TYPESAFE_API_KEY is required")
    auth = Path(os.environ["JEV_CODEX_AUTH_FILE"])
    state = json.loads(auth.read_text())
    if state.get("auth_mode") != "chatgpt" or state.get("OPENAI_API_KEY"):
        raise ValueError("Existing ChatGPT login required")
    (root / "console").mkdir()
    (root / "jobs").mkdir()
    lock, stop = threading.Lock(), threading.Event()

    def pair(task: str) -> None:
        for row in [entry for entry in rows if entry["task"] == task]:
            with lock:
                if stop.is_set():
                    row["state"] = "blocked"
                    save(root / "progress.json", rows)
                    continue
                row["state"] = "running"
                row["started_at"] = datetime.now(UTC).isoformat()
                save(root / "progress.json", rows)
            env = {
                key: value for key, value in os.environ.items() if key not in OVERRIDES
            }
            env.update(
                {
                    "PYTHONPATH": str(REPO),
                    "JEV_EVAL_ARM": row["arm"],
                    "MODAL_IMAGE_BUILDER_VERSION": protocol[
                        "modal_image_builder_version"
                    ],
                }
            )
            command = [
                harbor,
                "run",
                *protocol["flags"],
                "-i",
                task,
                "--job-name",
                row["job_name"],
                "--jobs-dir",
                str(root / "jobs"),
            ]
            try:
                with (root / "console" / f"{row['job_name']}.log").open("w") as output:
                    result = subprocess.run(
                        command,
                        cwd=REPO,
                        env=env,
                        stdout=output,
                        stderr=subprocess.STDOUT,
                    )
                row["returncode"] = result.returncode
                row["state"] = "finished"
                reason = blocking_failure(root / "jobs" / row["job_name"])
                if reason:
                    row["blocker"] = reason
                    stop.set()
            except OSError as error:
                row["state"] = "launcher_error"
                row["error"] = str(error)
                stop.set()
            finally:
                with lock:
                    row["finished_at"] = datetime.now(UTC).isoformat()
                    save(root / "progress.json", rows)
                    print(f"{task} {row['arm']}: {row['state']}", flush=True)

    with ThreadPoolExecutor(max_workers=protocol["concurrency"]) as pool:
        list(pool.map(pair, protocol["selected_tasks"]))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["plan", "run"])
    parser.add_argument("root", type=Path)
    parser.add_argument("--benchmark", type=Path)
    parser.add_argument("--phase", choices=["pilot", "comparison"], default="pilot")
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--harbor", default="harbor")
    args = parser.parse_args()
    if not 1 <= args.concurrency <= 32:
        parser.error("concurrency must be 1–32")
    if args.action == "plan":
        if args.benchmark is None:
            parser.error("--benchmark is required for planning")
        plan(
            args.root.resolve(), args.benchmark.resolve(), args.phase, args.concurrency
        )
    else:
        run(args.root.resolve(), args.harbor)


if __name__ == "__main__":
    main()
