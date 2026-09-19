"""Summarize saved Harbor trials without making network requests."""

import argparse
import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path, PurePosixPath
from statistics import median

TRIM_LOG = re.compile(r"kept (\d+)/(\d+) chunks \((\d+)→(\d+) chars\)")
TRIM_MARKER = re.compile(r"\[fast-jev-output trimmed (\d+) lines \((\d+) chars\)")
PRUNED_OUTPUT = re.compile(
    r"\[fast-jev-output (?:trimmed(?: \d+ (?:more )?lines|;)|cut this section to fit)"
)
DECISION_PREFIX = "fast-jev-output decision "
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


def result_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            block["text"]
            for block in content
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        )
    return ""


def utf16_chars(text: str) -> int:
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


def summarize_decisions(events: list[dict], logs: list[str], bash: list[dict]) -> dict:
    decisions = []
    malformed = 0
    for text in logs:
        if not text.startswith(DECISION_PREFIX):
            continue
        try:
            decision = json.loads(text[len(DECISION_PREFIX) :])
            if (
                not isinstance(decision, dict)
                or decision.get("version") != 1
                or not isinstance(decision.get("decision"), str)
                or (
                    decision.get("toolUseId") is not None
                    and not isinstance(decision["toolUseId"], str)
                )
            ):
                raise ValueError("Unsupported decision")
            decisions.append(decision)
        except (ValueError, TypeError):
            malformed += 1
    calls = {}
    results = {}
    call_order = {}
    result_order = {}
    explanations = {}
    last_explanation = ""
    for event_index, event in enumerate(events):
        message = event.get("message")
        if not isinstance(message, dict) or not isinstance(
            message.get("content"), list
        ):
            continue
        for block in message["content"]:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                last_explanation = block["text"]
            if block.get("type") == "tool_use" and isinstance(block.get("id"), str):
                calls[block["id"]] = block
                call_order[block["id"]] = event_index
                explanations[block["id"]] = last_explanation
            if block.get("type") == "tool_result" and isinstance(
                block.get("tool_use_id"), str
            ):
                results[block["tool_use_id"]] = result_text(block.get("content"))
                result_order[block["tool_use_id"]] = event_index
                last_explanation = ""
    archives = {
        match[1] for text in results.values() for match in ARCHIVE_FOOTER.finditer(text)
    }
    for record in bash:
        output = record.get("answer", {}).get("result")
        if isinstance(output, dict) and isinstance(
            output.get("persistedOutputPath"), str
        ):
            archives.add(output["persistedOutputPath"])
    accesses = []
    commands: Counter[str] = Counter()
    for identifier, call in calls.items():
        arguments = call.get("input") or {}
        if not isinstance(arguments, dict):
            continue
        if call.get("name") == "Bash" and isinstance(arguments.get("command"), str):
            commands[arguments["command"]] += 1
        if call.get("name") not in {"Bash", "Read", "Grep"}:
            continue
        argument_text = json.dumps(arguments, ensure_ascii=False)
        matched = sorted(path for path in archives if path in argument_text)
        if matched:
            prior_prunes = [
                tool_id
                for tool_id, text in results.items()
                if PRUNED_OUTPUT.search(text)
                and result_order[tool_id] < call_order[identifier]
                and any(path in text for path in matched)
            ]
            accesses.append(
                {
                    "tool_use_id": identifier,
                    "tool": call["name"],
                    "paths": matched,
                    "after_pruned_tool_ids": prior_prunes,
                    "stated_reason": explanations[identifier] or None,
                    "reason_classification": "unreviewed",
                }
            )
    visible = []
    for decision in decisions:
        identifier = decision.get("toolUseId")
        before = decision.get("modelVisibleCharsBefore")
        after = utf16_chars(results[identifier]) if identifier in results else None
        visible.append(
            {
                "tool_use_id": identifier,
                "decision": decision.get("decision"),
                "source_chars": decision.get("sourceChars"),
                "model_visible_chars_before": before,
                "model_visible_chars_after": after,
                "delta_chars": after - before
                if isinstance(before, int) and after is not None
                else None,
            }
        )
    deltas = [row["delta_chars"] for row in visible if row["delta_chars"] is not None]
    return {
        "pruning_diagnostics": decisions,
        "pruning_decision_counts": dict(
            Counter(row.get("decision", "unknown") for row in decisions)
        ),
        "malformed_pruning_diagnostics": malformed,
        "visible_output_pairs": visible,
        "visible_output_pairs_measured": len(deltas),
        "model_visible_char_delta_on_measured_calls": sum(deltas) if deltas else None,
        "model_visible_bash_chars": sum(
            utf16_chars(text)
            for identifier, text in results.items()
            if calls.get(identifier, {}).get("name") == "Bash"
        ),
        "archive_accesses_observed": accesses,
        "archive_access_count": len(accesses),
        "repeated_bash_calls": sum(count - 1 for count in commands.values()),
        "visible_output_note": (
            "UTF-16 character counts, not billed tokens. Before is native text at the hook; "
            "after is final transcript text. Archive accesses match explicit path arguments only."
        ),
    }


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
        and PRUNED_OUTPUT.search(result_text(block.get("content")))
    ]
    if len(results) != len(trims):
        issues.append("Pruning logs and transcript tool-result counts disagree")
    for result in results:
        archive = evidence / "archives" / f"bash-{result['tool_use_id']}.txt"
        if not archive.exists() and not native_archive_exists(
            agent, result_text(result.get("content"))
        ):
            issues.append(f"Missing original output for {result['tool_use_id']}")
    markers = [
        m
        for result in results
        for m in TRIM_MARKER.finditer(result_text(result.get("content")))
    ]
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
    bash_records = [
        json.loads(path.read_text()) for path in evidence.glob("bash-*.json")
    ]
    bash_outputs = [record.get("answer", {}).get("result") for record in bash_records]
    decisions = summarize_decisions(events, logs, bash_records)
    if decisions["malformed_pruning_diagnostics"]:
        issues.append("Malformed pruning diagnostics")
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
        **decisions,
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
        "claude_turns": final.get("num_turns"),
        "bash_calls_observed": len(list(evidence.glob("bash-*.json"))),
        "bash_structured_outputs_observed": len(output_lengths),
        "bash_max_observed_chars": max(output_lengths, default=0),
        "bash_observed_outputs_above_min_chars": sum(n > 4000 for n in output_lengths),
        "bash_character_threshold_note": "Legacy 4000-character statistic; not current pruning eligibility",
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
