"""Summarize saved Harbor trials without making network requests."""

import argparse
import json
import re
from datetime import datetime
from pathlib import Path, PurePosixPath
from statistics import median

TRIM_LOG = re.compile(r"kept (\d+)/(\d+) chunks \((\d+)→(\d+) chars\)")
TRIM_MARKER = re.compile(r"\[fast-jev-output trimmed (\d+) lines \((\d+) chars\)")
ARCHIVE_FOOTER = re.compile(
    r"\[fast-jev-output (?:trimmed \d+ lines \(\d+ chars\); )?"
    r"full output: ([^\n]+) \(Read or grep it if needed\)\]"
)


def native_archive_exists(agent: Path, content: str) -> bool:
    matches = list(ARCHIVE_FOOTER.finditer(content))
    if not matches:
        return False
    remote = PurePosixPath(matches[-1][1])
    base = (agent / "sessions/projects").resolve()
    if not base.is_relative_to(agent.resolve()):
        return False
    for prefix in ("/opt/jev-eval/auth/projects", "/logs/agent/sessions/projects"):
        if not remote.is_relative_to(prefix):
            continue
        relative = remote.relative_to(prefix)
        if (
            len(relative.parts) != 4
            or ".." in relative.parts
            or relative.parts[2] != "tool-results"
            or relative.suffix != ".txt"
        ):
            return False
        candidate = (base / str(relative)).resolve()
        return candidate.is_relative_to(base) and candidate.is_file()
    return False


def read_events(path: Path) -> list[dict]:
    events = []
    for line in path.read_text().splitlines() if path.exists() else []:
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            events.append(item)
    return events


def elapsed(timing: dict) -> float | None:
    if not timing.get("started_at") or not timing.get("finished_at"):
        return None
    return (
        datetime.fromisoformat(timing["finished_at"])
        - datetime.fromisoformat(timing["started_at"])
    ).total_seconds()


def summarize_agent(agent: Path, arm: str, stream: str = "claude-code.txt") -> dict:
    events = read_events(agent / stream)
    final = next((e for e in reversed(events) if e.get("type") == "result"), {})
    init = next((e for e in events if e.get("subtype") == "init"), {})
    plugins = sorted(p["name"] for p in init.get("plugins", []))
    expected = sorted(
        ["jev-eval-observer"] + (["fast-jev-output"] if arm == "plugin" else [])
    )
    issues = []
    if plugins != expected:
        issues.append(f"Unexpected plugins: {plugins}")
    evidence = agent / "jev"
    if not (evidence / "activated.json").exists():
        issues.append("Observer activation missing")
    if not final:
        issues.append("Final Claude result missing; usage totals unavailable")
    elif final.get("is_error") or final.get("subtype") != "success":
        issues.append(f"Claude did not finish successfully: {final.get('subtype')}")
    logs = [
        json.loads(path.read_text())["text"]
        for path in sorted(evidence.glob("log-*.json"))
    ]
    trims = [match for text in logs if (match := TRIM_LOG.search(text))]
    results = [
        block
        for event in events
        if isinstance(event.get("message"), dict)
        for block in event["message"].get("content", [])
        if isinstance(block, dict)
        and block.get("type") == "tool_result"
        and isinstance(block.get("content"), str)
        and TRIM_MARKER.search(block["content"])
    ]
    if len(results) != len(trims):
        issues.append("Pruning logs and transcript tool-result counts disagree")
    for result in results:
        archive = evidence / "archives" / f"bash-{result['tool_use_id']}.txt"
        if not archive.exists() and not native_archive_exists(agent, result["content"]):
            issues.append(f"Missing original output for {result['tool_use_id']}")
    markers = [m for result in results for m in TRIM_MARKER.finditer(result["content"])]
    requests = [
        json.loads(path.read_text())
        for path in sorted(evidence.glob("request-*.json"))
        if not path.name.endswith("-started.json")
    ]
    started = len(list(evidence.glob("request-*-started.json")))
    latencies = [request["durationMs"] for request in requests]
    responses = []
    for request in requests:
        response = request.get("response")
        if response:
            try:
                body = json.loads(response["body"])
            except json.JSONDecodeError:
                body = {}
            responses.append({**response, "body": body})
    errors = [text for text in logs if "trim skipped" in text]
    if started != len(requests):
        issues.append("Jev requests without captured responses")
    if errors or any(response["status"] != 200 for response in responses):
        issues.append(
            "Jev errors occurred; inspect captures before interpreting savings"
        )
    if arm == "control" and (started or trims):
        issues.append("Control unexpectedly invoked pruning")
    bash_outputs = [
        json.loads(path.read_text()).get("answer", {}).get("result")
        for path in evidence.glob("bash-*.json")
    ]
    output_lengths = [
        len(
            output.get("stdout", "")
            + ("\n" + output["stderr"] if output.get("stderr") else "")
        )
        for output in bash_outputs
        if isinstance(output, dict) and isinstance(output.get("stdout"), str)
    ]
    model_usage = final.get("modelUsage") or {}
    totals = (
        {
            key: sum(model.get(key, 0) for model in model_usage.values())
            for key in (
                "inputTokens",
                "cacheReadInputTokens",
                "cacheCreationInputTokens",
                "outputTokens",
                "thinkingTokens",
            )
        }
        if model_usage
        else None
    )
    return {
        "model": init.get("model"),
        "plugins": plugins,
        "observer_loaded": (evidence / "activated.json").exists(),
        "measurement_issues": issues,
        "claude_result_subtype": final.get("subtype"),
        "claude_is_error": final.get("is_error"),
        "claude_usage": final.get("usage"),
        "claude_cost_usd_reported": final.get("total_cost_usd"),
        "claude_model_usage": final.get("modelUsage"),
        "claude_all_models_usage": totals,
        "claude_cost_basis": sorted(
            {
                model["costBasis"]
                for model in model_usage.values()
                if model.get("costBasis")
            }
        ),
        "claude_duration_ms": final.get("duration_ms"),
        "bash_calls_observed": len(list(evidence.glob("bash-*.json"))),
        "bash_structured_outputs_observed": len(output_lengths),
        "bash_max_observed_chars": max(output_lengths, default=0),
        "bash_observed_outputs_above_min_chars": sum(n > 4000 for n in output_lengths),
        "jev_requests_started": started,
        "jev_responses": len(responses),
        "jev_http_statuses": [response["status"] for response in responses],
        "jev_models": sorted(
            {
                response["body"]["model"]
                for response in responses
                if response["body"].get("model")
            }
        ),
        "jev_latency_total_ms": sum(latencies),
        "jev_latency_median_ms": median(latencies) if latencies else None,
        "jev_usage": [response["body"].get("usage") for response in responses],
        "jev_cost_usd": None,
        "jev_cost_note": "No price or billed cost returned; not assumed free",
        "hook_errors": errors,
        "pruned_outputs": len(trims),
        "pruned_results_in_transcript": len(results),
        "chunks_before": sum(int(m[2]) for m in trims),
        "chunks_kept": sum(int(m[1]) for m in trims),
        "chars_before_pruned_outputs": sum(int(m[3]) for m in trims),
        "chars_after_pruned_outputs": sum(int(m[4]) for m in trims),
        "net_chars_saved": sum(int(m[3]) - int(m[4]) for m in trims),
        "raw_chars_removed": sum(int(m[2]) for m in markers),
        "lines_removed": sum(int(m[1]) for m in markers),
    }


def summarize_trial(path: Path) -> dict:
    trial = json.loads(path.read_text())
    settings_path = path.parent / "agent/eval-settings.json"
    settings = (
        json.loads(settings_path.read_text())
        if settings_path.exists()
        else {"arm": path.parent.parent.name.rsplit("-", 1)[-1]}
    )
    exception = trial.get("exception_info")
    return {
        "task": trial["task_name"],
        "arm": settings["arm"],
        "auth_mode": settings.get("auth_mode"),
        "auth_status": settings.get("auth_status"),
        "claude_billing_note": (
            "Subscription limits apply; CLI dollar amounts are not a subscription bill"
            if settings.get("auth_mode") == "subscription"
            else "CLI dollar amounts are estimates, not independently verified billing"
        ),
        "trial_name": trial["trial_name"],
        "task_revision": trial["task_id"]["git_commit_id"],
        "task_checksum": trial["task_checksum"],
        "reward": (trial.get("verifier_result") or {}).get("rewards", {}).get("reward"),
        "exception": exception,
        "agent_setup": trial.get("agent_setup"),
        "agent_execution": trial.get("agent_execution"),
        "wall_seconds": elapsed(trial),
        "agent_seconds": elapsed(trial.get("agent_execution") or {}),
        "verifier_seconds": elapsed(trial.get("verifier") or {}),
        "harbor_agent_metrics": trial.get("agent_result"),
        **summarize_agent(path.parent / "agent", settings["arm"]),
    }


def summarize_smoke(path: Path, arm: str) -> dict:
    row = summarize_agent(path, arm, stream="events.jsonl")
    if row["model"] != "claude-sonnet-5":
        row["measurement_issues"].append("Smoke model does not match pin")
    if row["bash_calls_observed"] != 1:
        row["measurement_issues"].append("Smoke must execute exactly one Bash call")
    if arm == "plugin" and not (
        row["jev_responses"] > 0
        and all(status == 200 for status in row["jev_http_statuses"])
        and row["pruned_results_in_transcript"] > 0
        and row["net_chars_saved"] > 0
    ):
        row["measurement_issues"].append("Smoke did not prove real Jev trimming")
    auth_path = path / "auth-status.json"
    row["auth_status"] = (
        json.loads(auth_path.read_text()) if auth_path.exists() else None
    )
    return row


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("evidence", type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--smoke-arm", choices=("control", "plugin"))
    mode.add_argument("--job", action="store_true")
    args = parser.parse_args()
    if args.smoke_arm:
        row = summarize_smoke(args.evidence, args.smoke_arm)
        (args.evidence / "summary.json").write_text(json.dumps(row, indent=2) + "\n")
        if row["measurement_issues"]:
            raise SystemExit("; ".join(row["measurement_issues"]))
        print(f"{args.smoke_arm} activation smoke passed")
        return
    if args.job:
        paths = list(args.evidence.glob("*/result.json"))
        if len(paths) != 1:
            raise SystemExit("Expected one completed trial; stopping pilot")
        row = summarize_trial(paths[0])
        if row["exception"] or row["measurement_issues"] or row["reward"] is None:
            raise SystemExit(
                "Failed or invalid trial; stopping pilot, inspect evidence"
            )
        return
    paths = sorted((args.evidence / "jobs").glob("pilot-*/*/result.json"))
    rows = [summarize_trial(path) for path in paths]
    paired = []
    for task in sorted({row["task"] for row in rows}):
        arms = {row["arm"]: row for row in rows if row["task"] == task}
        control, plugin = arms.get("control"), arms.get("plugin")
        complete = bool(
            control
            and plugin
            and all(row["reward"] is not None for row in (control, plugin))
        )
        paired.append(
            {
                "task": task,
                "both_rewards_available": complete,
                "control_reward": control["reward"] if control else None,
                "plugin_reward": plugin["reward"] if plugin else None,
                "disagreement": control["reward"] != plugin["reward"]
                if complete and control and plugin
                else None,
            }
        )
    output = {"trials": rows, "pairs": paired, "expected_trials": 6}
    (args.evidence / "results.json").write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps({"trials": len(rows), "pairs": paired}, indent=2))
    if len(rows) != 6 or any(
        row["measurement_issues"] or row["exception"] for row in rows
    ):
        raise SystemExit("Incomplete or invalid measurements; inspect results.json")


if __name__ == "__main__":
    main()
