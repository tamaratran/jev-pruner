"""Matched runs with bounded concurrency, checkpoints, and access stops."""

import argparse
import hashlib
import json
import os
import shutil
import signal
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

import tomllib

from evals.auth import AUTH_OVERRIDES, subscription_mounts
from evals.sources import (
    PRODUCTION,
    plugin_options,
    production_provenance,
    production_root,
)
from evals.summarize import read_events, summarize_trial

REPO = Path(__file__).resolve().parents[1]
REGISTRY = "https://raw.githubusercontent.com/laude-institute/harbor/b83e7686999a18ba90a8603794d7d18d42cab010/registry.json"
MODEL = "anthropic/claude-sonnet-5"
FLAGS = [
    "-d",
    "terminal-bench@2.0",
    "--registry-url",
    REGISTRY,
    "-a",
    "evals.harbor_agent:JevClaudeCode",
    "-m",
    MODEL,
    "--ak",
    "version=2.1.274",
    "--ak",
    "max_budget_usd=3",
    "--ak",
    "max_turns=80",
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
]


class TrialProcess(Protocol):
    pid: int
    returncode: int | None

    def poll(self) -> int | None: ...

    def wait(self, timeout: float | None = None) -> int: ...


def save(path: Path, value: object) -> None:
    temporary = path.with_suffix(".new")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def source_hashes() -> dict[str, str]:
    hashes = {}
    for root, directories in (
        (REPO, ("evals",)),
        (production_root(REPO), PRODUCTION),
    ):
        names = subprocess.check_output(
            ["git", "ls-files", *directories], cwd=root, text=True
        ).splitlines()
        hashes.update(
            {
                name: hashlib.sha256((root / name).read_bytes()).hexdigest()
                for name in names
            }
        )
    return hashes


def access_blocker(events: list[dict]) -> str | None:
    for event in events:
        if event.get("subtype") == "init" and event.get("model") != "claude-sonnet-5":
            return "Unexpected model in Claude init event"
        if (
            event.get("type") == "rate_limit_event"
            and (event.get("rate_limit_info") or {}).get("status") == "rejected"
        ):
            return "Claude subscription rate limit rejected the request"
        error = event.get("error")
        if not (event.get("is_error") or error or event.get("type") == "error"):
            continue
        text = json.dumps(event).lower()
        if any(
            marker in text
            for marker in (
                "rate_limit",
                "rate limit",
                "usage limit",
                "hit your limit",
                "authentication_error",
                "invalid_api_key",
                "not logged in",
                "oauth token",
                "subscription limit",
                "insufficient_quota",
                "credit balance is too low",
                '"status": 429',
                '"status": 401',
            )
        ):
            return "Claude authentication or account limit error; inspect saved stream"
        if "model" in text and any(
            marker in text
            for marker in (
                "not found",
                "not available",
                "not allowed",
                "does not exist",
                "do not have access",
            )
        ):
            return "Requested model unavailable on this subscription"
    return None


def trial_blocker(job: Path) -> str | None:
    for stream in job.glob("*/agent/claude-code.txt"):
        reason = access_blocker(read_events(stream))
        if reason:
            return reason
    for result in job.glob("*/result.json"):
        try:
            trial = json.loads(result.read_text())
            exception = trial.get("exception_info") or {}
        except json.JSONDecodeError:
            continue
        if "subscription" in str(exception.get("exception_message", "")).lower():
            return "Subscription preflight failed"
        category = failure_category({**trial, "exception": exception})
        if category in {"agent_setup", "infrastructure"}:
            return f"{category} failure; inspect trial evidence"
    return None


def failure_category(row: dict) -> str | None:
    exception = row.get("exception") or {}
    kind = exception.get("exception_type", "")
    if kind.startswith("Environment") or "Build" in kind or "Download" in kind:
        return "infrastructure"
    if "Verifier" in kind or "Reward" in kind:
        return "verifier"
    if "Setup" in kind or (
        exception
        and (row.get("agent_setup") or {}).get("started_at")
        and not (row.get("agent_execution") or {}).get("started_at")
    ):
        return "agent_setup"
    if exception or row.get("claude_is_error"):
        return "agent"
    if row.get("measurement_issues"):
        return "instrumentation"
    if row.get("reward") == 0:
        return "task_failure"
    return None


def aggregate(rows: list[dict]) -> dict:
    arms = {}
    for arm in ("control", "plugin"):
        group = [row for row in rows if row["arm"] == arm]
        finished = [row for row in group if row["state"] == "finished"]
        measured = [
            row for row in finished if row.get("claude_all_models_usage") is not None
        ]
        jev_usage: dict[str, float] = {}
        for row in finished:
            for usage in row.get("jev_usage", []):
                for key, value in (usage or {}).items():
                    if isinstance(value, (int, float)) and not isinstance(value, bool):
                        jev_usage[key] = jev_usage.get(key, 0) + value
        arms[arm] = {
            "planned": len(group),
            "finished": len(finished),
            "resource_blocked": sum(
                row["state"] == "resource_blocked" for row in group
            ),
            "not_finished": sum(
                row["state"] not in {"finished", "resource_blocked"} for row in group
            ),
            "rewards_available": sum(row.get("reward") is not None for row in finished),
            "successful_tasks": sum(row.get("reward") == 1 for row in finished),
            "claude_usage_complete_trials": len(measured),
            "claude_tokens_known": {
                key: sum(row["claude_all_models_usage"].get(key, 0) for row in measured)
                for key in (
                    "inputTokens",
                    "cacheReadInputTokens",
                    "cacheCreationInputTokens",
                    "outputTokens",
                    "thinkingTokens",
                )
            },
            "claude_estimated_usd_known": sum(
                row.get("claude_cost_usd_reported") or 0 for row in finished
            ),
            "claude_estimate_available_trials": sum(
                row.get("claude_cost_usd_reported") is not None for row in finished
            ),
            "subscription_billed_usd": None,
            "wall_seconds_known": sum(row.get("wall_seconds") or 0 for row in finished),
            "jev_requests": sum(row.get("jev_requests_started", 0) for row in finished),
            "jev_usage_known": jev_usage,
            "jev_latency_total_ms": sum(
                row.get("jev_latency_total_ms", 0) for row in finished
            ),
            "jev_cost_usd": None,
            "pruned_outputs": sum(row.get("pruned_outputs", 0) for row in finished),
            "net_chars_saved": sum(row.get("net_chars_saved", 0) for row in finished),
            "measurement_issue_trials": sum(
                bool(row.get("measurement_issues")) for row in finished
            ),
        }
    pairs = []
    for task, repetition in sorted(
        {(row["task"], row.get("repetition", 1)) for row in rows}
    ):
        by_arm = {
            row["arm"]: row
            for row in rows
            if row["task"] == task and row.get("repetition", 1) == repetition
        }
        control, plugin = by_arm["control"], by_arm["plugin"]
        complete = all(row.get("reward") is not None for row in (control, plugin))
        pairs.append(
            {
                "task": task,
                "repetition": repetition,
                "both_rewards_available": complete,
                "control_state": control["state"],
                "plugin_state": plugin["state"],
                "control_reward": control.get("reward"),
                "plugin_reward": plugin.get("reward"),
                "disagreement": control.get("reward") != plugin.get("reward")
                if complete
                else None,
            }
        )
    return {
        "trials": rows,
        "pairs": pairs,
        "aggregate": arms,
        "expected_trials": len(rows),
    }


def checkpoint(root: Path, rows: list[dict]) -> None:
    save(root / "progress.json", rows)
    save(root / "results.json", aggregate(rows))


def next_pending(rows: list[dict]) -> int | None:
    running_tasks = {
        (row["task"], row.get("repetition", 1))
        for row in rows
        if row["state"] == "running"
    }
    return next(
        (
            index
            for index, row in enumerate(rows)
            if row["state"] == "pending"
            and (row["task"], row.get("repetition", 1)) not in running_tasks
        ),
        None,
    )


def stop_trial(process: TrialProcess) -> None:
    try:
        os.killpg(process.pid, signal.SIGINT)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=120)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=30)


def finish_trial(root: Path, row: dict, environment: str) -> str | None:
    job = root / "jobs" / row["job_name"]
    reason = trial_blocker(job)
    paths = list(job.glob("*/result.json"))
    if len(paths) == 1:
        row.update(summarize_trial(paths[0]))
        row["failure_category"] = failure_category(row)
        row["state"] = "finished"
    else:
        row["state"] = "infrastructure_error"
        row["failure_category"] = "infrastructure"
        row["error"] = f"Expected one trial result, found {len(paths)}"
        reason = reason or row["error"]
    if environment == "docker":
        inspected = subprocess.run(
            [
                "docker",
                "image",
                "inspect",
                row["requested_docker_image"],
                "--format",
                "{{json .RepoDigests}}",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if inspected.returncode == 0:
            row["image_repo_digests"] = json.loads(inspected.stdout)
    if row.get("task_revision") not in {
        None,
        "69671fbaac6d67a7ef0dfec016cc38a64ef7a77c",
    }:
        reason = "Unexpected benchmark revision in trial result"
    issues = row.get("measurement_issues") or []
    if row.get("model") and any(
        issue.startswith(
            (
                "Unexpected plugins",
                "Observer activation missing",
                "Pruning logs",
                "Missing original output",
                "Jev errors",
                "Jev requests",
            )
        )
        for issue in issues
    ):
        reason = reason or "Instrumentation or Jev failure; inspect trial evidence"
    return reason


def continuation_rows(
    root: Path,
    manifest: list[dict],
    flags: list[str],
    pin: dict,
    inflight: set[str] | None = None,
) -> list[dict]:
    previous = json.loads((root / "execution-provenance.json").read_text())
    if previous.get("plugin_options", {}) != plugin_options():
        raise ValueError("Cannot resume with different plugin options")
    if previous["flags"] != flags:
        raise ValueError("Cannot resume with different trial flags")
    production = (".claude-plugin/", "hooks/", "src/")
    if {
        key: value
        for key, value in previous["source_sha256"].items()
        if key.startswith(production)
    } != {key: value for key, value in pin.items() if key.startswith(production)}:
        raise ValueError("Cannot resume with different production sources")
    rows = json.loads((root / "progress.json").read_text())
    if len(rows) != len(manifest) or any(
        any(row.get(key) != value for key, value in item.items())
        for row, item in zip(rows, manifest, strict=True)
    ):
        raise ValueError("Checkpoint does not match the declared manifest")
    for row in rows:
        if row["state"] == "running" and row["job_name"] in (inflight or set()):
            row.setdefault("execution_commit", previous["commit"])
            continue
        if row["state"] == "running":
            job = root / "jobs" / row["job_name"]
            result = job / "result.json"
            paths = list(job.glob("*/result.json"))
            if (
                not result.exists()
                or not json.loads(result.read_text()).get("finished_at")
                or len(paths) != 1
            ):
                raise ValueError("Cannot resume an unfinished Harbor trial")
            row.update(summarize_trial(paths[0]))
            row["failure_category"] = failure_category(row)
            row["harbor_return_code"] = None
            row["recovered_from_completed_harbor_job"] = True
            row["state"] = "finished"
        if row["state"] not in {
            "pending",
            "finished",
            "resource_blocked",
            "infrastructure_error",
        }:
            raise ValueError("Unsupported checkpoint state")
        if row["state"] != "pending":
            row.setdefault("execution_commit", previous["commit"])
    if (inflight or set()) != {
        row["job_name"] for row in rows if row["state"] == "running"
    }:
        raise ValueError("In-flight processes must match running checkpoint rows")
    return rows


def validate_manifest(
    manifest: list[dict], task_count: int = 89, repetitions: int = 1
) -> None:
    tasks = {row["task"] for row in manifest}
    count = task_count * repetitions * 2
    if (
        repetitions < 1
        or task_count < 1
        or len(tasks) != task_count
        or len(manifest) != count
    ):
        raise ValueError(f"Expected {task_count} tasks and {count} trials")
    if {(row["task"], row["arm"], row.get("repetition", 1)) for row in manifest} != {
        (task, arm, repetition)
        for task in tasks
        for arm in ("control", "plugin")
        for repetition in range(1, repetitions + 1)
    }:
        raise ValueError(
            "Each task repetition must have exactly one control and one plugin arm"
        )
    if len({row["job_name"] for row in manifest}) != len(manifest):
        raise ValueError("Each trial must have a unique job_name")


def run(
    root: Path,
    benchmark: Path,
    harbor: str,
    environment: str = "docker",
    resume: bool = False,
    concurrency: int = 1,
    inflight: dict[str, TrialProcess] | None = None,
    task_count: int = 89,
    repetitions: int = 1,
) -> None:
    if concurrency < 1:
        raise ValueError("Concurrency must be positive")
    if inflight and not resume:
        raise ValueError("In-flight processes require resume")
    if os.environ.get("JEV_EVAL_AUTH_MODE") != "subscription":
        raise ValueError("Explicit JEV_EVAL_AUTH_MODE=subscription is required")
    if (root / "progress.json").exists() and not resume:
        raise ValueError("Refusing to reuse a started run")
    if resume and not (root / "progress.json").exists():
        raise ValueError("No checkpoint to resume")
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=REPO):
        raise ValueError("Commit sources before execution")
    production = production_provenance(REPO)
    if subprocess.check_output([harbor, "--version"], text=True).strip() != "0.22.0":
        raise ValueError("Harbor 0.22.0 required")
    os.environ["EVIDENCE_DIR"] = str(root)
    mounts = subscription_mounts()
    environment_flags = ["--env", environment]
    if environment == "docker":
        environment_flags += ["--mounts", json.dumps(mounts)]
    elif environment == "modal":
        environment_flags += ["--ek", "app_name=jev-terminal-bench"]
    else:
        raise ValueError("Supported environments are docker and modal")
    env = {key: value for key, value in os.environ.items() if key not in AUTH_OVERRIDES}
    env["PYTHONPATH"] = str(REPO)
    if environment == "modal":
        env["MODAL_IMAGE_BUILDER_VERSION"] = "2025.06"
    if not env.get("TYPESAFE_API_KEY") or env["TYPESAFE_API_KEY"].startswith("secret:"):
        raise ValueError("Inject the Jev key before execution")
    manifest = json.loads((root / "manifest.json").read_text())
    validate_manifest(manifest, task_count, repetitions)
    pin = source_hashes()
    rows = (
        continuation_rows(
            root, manifest, FLAGS + environment_flags, pin, set(inflight or {})
        )
        if resume
        else [
            {
                **row,
                "state": "resource_blocked" if row["resource_blocked"] else "pending",
            }
            for row in manifest
        ]
    )
    provenance = {
        **production,
        "started_at": datetime.now(UTC).isoformat(),
        "commit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=REPO, text=True
        ).strip(),
        "source_sha256": pin,
        "flags": FLAGS + environment_flags,
        "environment": environment,
        "modal_image_builder_version": (
            env["MODAL_IMAGE_BUILDER_VERSION"] if environment == "modal" else None
        ),
        "auth_mode": "subscription",
        "plugin_options": plugin_options(),
        "api_overrides_present_in_launcher": sorted(set(AUTH_OVERRIDES) & set(env)),
        "concurrency": concurrency,
        "task_count": task_count,
        "repetitions": repetitions,
        "trial_count": len(manifest),
        "pair_arm_order": "manifest; arms of the same task repetition never overlap",
        "harbor_retries": 0,
        "resume": resume,
        "adopted_jobs": sorted(inflight or {}),
        "pending_trials": sum(row["state"] == "pending" for row in rows),
    }
    segments_path = root / "execution-segments.json"
    if resume:
        segments = json.loads(
            (
                segments_path
                if segments_path.exists()
                else root / "execution-provenance.json"
            ).read_text()
        )
        if not isinstance(segments, list):
            segments = [segments]
        if (root / "blocker.json").exists():
            (root / "blocker.json").rename(
                root / f"blocker-before-segment-{len(segments) + 1}.json"
            )
    else:
        save(root / "execution-provenance.json", provenance)
        segments = []
    save(segments_path, [*segments, provenance])
    (root / "jobs").mkdir(exist_ok=resume)
    (root / "console").mkdir(exist_ok=resume)
    active: dict[int, TrialProcess] = {}
    for index, row in enumerate(rows):
        if inflight and row["job_name"] in inflight:
            active[index] = inflight[row["job_name"]]
            row.setdefault("launcher_handoffs", []).append(
                {
                    "at": provenance["started_at"],
                    "commit": provenance["commit"],
                    "concurrency": concurrency,
                }
            )
    checkpoint(root, rows)
    paused = False

    def pause(index: int, reason: str) -> None:
        nonlocal paused
        if not paused:
            save(
                root / "blocker.json",
                {
                    "reason": reason,
                    "index": index,
                    "task": rows[index]["task"],
                    "arm": rows[index]["arm"],
                },
            )
            print(f"PAUSED: {reason}", flush=True)
        paused = True

    while True:
        for index, process in list(active.items()):
            row = rows[index]
            reason = trial_blocker(root / "jobs" / row["job_name"])
            if reason:
                pause(index, reason)
                if process.poll() is None:
                    stop_trial(process)
            if process.poll() is None:
                continue
            row["harbor_return_code"] = process.returncode
            final_reason = finish_trial(root, row, environment)
            reason = reason or final_reason
            checkpoint(root, rows)
            print(
                f"END {index + 1}/{len(rows)} reward={row.get('reward')} category={row.get('failure_category')}",
                flush=True,
            )
            del active[index]
            if reason:
                pause(index, reason)
        while not paused and len(active) < concurrency:
            candidate = next_pending(rows)
            if candidate is None:
                break
            index = candidate
            row = rows[index]
            if source_hashes() != pin:
                pause(index, "Sources changed during run; no further trials started")
                break
            if shutil.disk_usage(root).free < 20 * 1024**3:
                pause(index, "Less than 20 GiB disk free before next trial")
                break
            task_config = tomllib.loads(
                (benchmark / row["task"] / "task.toml").read_text()
            )
            row["requested_docker_image"] = task_config["environment"]["docker_image"]
            command = [
                harbor,
                "run",
                *FLAGS,
                "-i",
                row["task"],
                "--job-name",
                row["job_name"],
                "--jobs-dir",
                str(root / "jobs"),
                *environment_flags,
            ]
            row["command"] = command
            row["execution_commit"] = provenance["commit"]
            row["execution_concurrency"] = concurrency
            row["state"] = "running"
            checkpoint(root, rows)
            print(
                f"START {index + 1}/{len(rows)} {row['task']} {row['arm']}", flush=True
            )
            try:
                with (root / "console" / f"{row['job_name']}.txt").open("w") as output:
                    active[index] = subprocess.Popen(
                        command,
                        env={**env, "JEV_EVAL_ARM": row["arm"]},
                        cwd=REPO,
                        stdout=output,
                        stderr=subprocess.STDOUT,
                        start_new_session=True,
                    )
            except OSError as error:
                row["state"] = "infrastructure_error"
                row["failure_category"] = "infrastructure"
                row["error"] = str(error)
                checkpoint(root, rows)
                pause(index, f"Could not start Harbor: {error}")
        if not active:
            break
        time.sleep(5)
    if not paused:
        save(root / "finished.json", {"finished_at": datetime.now(UTC).isoformat()})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("evidence", type=Path)
    parser.add_argument("--benchmark-source", type=Path, required=True)
    parser.add_argument("--harbor", default="harbor")
    parser.add_argument("--environment", choices=("docker", "modal"), default="docker")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--task-count", type=int, default=89)
    parser.add_argument("--repetitions", type=int, default=1)
    args = parser.parse_args()
    run(
        args.evidence.resolve(),
        args.benchmark_source.resolve(),
        args.harbor,
        args.environment,
        args.resume,
        args.concurrency,
        task_count=args.task_count,
        repetitions=args.repetitions,
    )
