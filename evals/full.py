"""Serial matched runs with immutable sources, explicit coverage, and access stops."""

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

import tomllib

from evals.auth import AUTH_OVERRIDES, subscription_mounts
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


def save(path: Path, value: object) -> None:
    temporary = path.with_suffix(".new")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def source_hashes() -> dict[str, str]:
    names = subprocess.check_output(
        ["git", "ls-files", "evals", ".claude-plugin", "hooks", "src"],
        cwd=REPO,
        text=True,
    ).splitlines()
    return {
        name: hashlib.sha256((REPO / name).read_bytes()).hexdigest() for name in names
    }


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
            exception = json.loads(result.read_text()).get("exception_info") or {}
        except json.JSONDecodeError:
            continue
        if "subscription" in str(exception.get("exception_message", "")).lower():
            return "Subscription preflight failed"
    return None


def failure_category(row: dict) -> str | None:
    exception = row.get("exception") or {}
    kind = exception.get("exception_type", "")
    if kind.startswith("Environment") or "Build" in kind or "Download" in kind:
        return "infrastructure"
    if "Verifier" in kind or "Reward" in kind:
        return "verifier"
    if "Setup" in kind:
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
    for task in sorted({row["task"] for row in rows}):
        by_arm = {row["arm"]: row for row in rows if row["task"] == task}
        control, plugin = by_arm["control"], by_arm["plugin"]
        complete = all(row.get("reward") is not None for row in (control, plugin))
        pairs.append(
            {
                "task": task,
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


def continuation_rows(
    root: Path, manifest: list[dict], flags: list[str], pin: dict
) -> list[dict]:
    previous = json.loads((root / "execution-provenance.json").read_text())
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
    return rows


def run(
    root: Path,
    benchmark: Path,
    harbor: str,
    environment: str = "docker",
    resume: bool = False,
) -> None:
    if os.environ.get("JEV_EVAL_AUTH_MODE") != "subscription":
        raise ValueError("Explicit JEV_EVAL_AUTH_MODE=subscription is required")
    if (root / "progress.json").exists() and not resume:
        raise ValueError("Refusing to reuse a started run")
    if resume and not (root / "progress.json").exists():
        raise ValueError("No checkpoint to resume")
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=REPO):
        raise ValueError("Commit sources before execution")
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
    if len(manifest) != 178 or len({row["task"] for row in manifest}) != 89:
        raise ValueError("Expected all 89 tasks and 178 trials")
    pin = source_hashes()
    rows = (
        continuation_rows(root, manifest, FLAGS + environment_flags, pin)
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
        "api_overrides_present_in_launcher": sorted(set(AUTH_OVERRIDES) & set(env)),
        "concurrency": 1,
        "harbor_retries": 0,
        "resume": resume,
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
    checkpoint(root, rows)
    for index, row in enumerate(rows):
        if row["state"] != "pending":
            continue
        if source_hashes() != pin:
            raise RuntimeError("Sources changed during run; no further trials started")
        if shutil.disk_usage(root).free < 20 * 1024**3:
            save(
                root / "blocker.json",
                {
                    "reason": "Less than 20 GiB disk free before next trial",
                    "index": index,
                },
            )
            return
        task_config = tomllib.loads((benchmark / row["task"] / "task.toml").read_text())
        image = task_config["environment"]["docker_image"]
        job = root / "jobs" / row["job_name"]
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
        row["state"] = "running"
        checkpoint(root, rows)
        print(f"START {index + 1}/178 {row['task']} {row['arm']}", flush=True)
        reason = None
        with (root / "console" / f"{row['job_name']}.txt").open("w") as output:
            process = subprocess.Popen(
                command,
                env={**env, "JEV_EVAL_ARM": row["arm"]},
                cwd=REPO,
                stdout=output,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            while process.poll() is None:
                reason = trial_blocker(job)
                if reason:
                    os.killpg(process.pid, signal.SIGINT)
                    try:
                        process.wait(timeout=120)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGTERM)
                        process.wait(timeout=30)
                    break
                time.sleep(5)
        row["harbor_return_code"] = process.returncode
        paths = list(job.glob("*/result.json"))
        if len(paths) == 1:
            row.update(summarize_trial(paths[0]))
            row["failure_category"] = failure_category(row)
            row["state"] = "finished"
        else:
            row["state"] = "infrastructure_error"
            row["failure_category"] = "infrastructure"
            row["error"] = f"Expected one trial result, found {len(paths)}"
        row["requested_docker_image"] = image
        if environment == "docker":
            inspected = subprocess.run(
                [
                    "docker",
                    "image",
                    "inspect",
                    image,
                    "--format",
                    "{{json .RepoDigests}}",
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            if inspected.returncode == 0:
                row["image_repo_digests"] = json.loads(inspected.stdout)
        checkpoint(root, rows)
        print(
            f"END {index + 1}/178 reward={row.get('reward')} category={row.get('failure_category')}",
            flush=True,
        )
        reason = reason or trial_blocker(job)
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
        if reason:
            save(
                root / "blocker.json",
                {
                    "reason": reason,
                    "index": index,
                    "task": row["task"],
                    "arm": row["arm"],
                },
            )
            print(f"PAUSED: {reason}", flush=True)
            return
    save(root / "finished.json", {"finished_at": datetime.now(UTC).isoformat()})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("evidence", type=Path)
    parser.add_argument("--benchmark-source", type=Path, required=True)
    parser.add_argument("--harbor", default="harbor")
    parser.add_argument("--environment", choices=("docker", "modal"), default="docker")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    run(
        args.evidence.resolve(),
        args.benchmark_source.resolve(),
        args.harbor,
        args.environment,
        args.resume,
    )
