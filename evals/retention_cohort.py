"""Repeated native-Claude retention trials, with recovery allowed."""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

from evals.answer_grading import score_answer
from evals.auth import (
    AUTH_OVERRIDES,
    AUTH_RUNTIME,
    prepare_subscription,
    subscription_mounts,
)
from evals.full import REPO, access_blocker, source_hashes
from evals.sources import PRODUCTION, plugin_options, production_root
from evals.retention_workloads import WORKLOADS, prepare_workloads
from evals.summarize import read_events, summarize_agent

CASES: dict[str, tuple[str, dict[str, str | int]]] = {
    "cache-build": (
        "Return the exact ERROR line as diagnostic, and the numeric exit_status.",
        {
            "diagnostic": "ERROR: deployment blocked because the release directory is not writable.",
            "exit_status": 1,
        },
    ),
    "npm-install": (
        "Return the number of high_vulnerabilities, packages_added, and elapsed_seconds.",
        {"high_vulnerabilities": 7, "packages_added": 903, "elapsed_seconds": 21},
    ),
    "pytest": (
        "Return failing_test (full test path and name), assertion (the assert expression), passed, and failed.",
        {
            "failing_test": "tests/test_checkout.py::test_discount",
            "assertion": "assert 7 == 10",
            "passed": 1799,
            "failed": 1,
        },
    ),
    "documentation": (
        "Find the payments service deployment timeout. Return setting (environment variable name) and value (integer).",
        {"setting": "REQUEST_TIMEOUT_MS", "value": 4700},
    ),
    "assembly": (
        "Find address 400d48. Return address (without 0x) and instruction (mnemonic and AT&T operands, without bytes).",
        {"address": "400d48", "instruction": "add $0x2a,%rax"},
    ),
    "source": (
        "Find paymentPolicy. Return its numeric timeout and retryCount.",
        {"timeout": 4700, "retryCount": 5},
    ),
}
EMIT = "node /fixture/emit.cjs"
TIMEOUT = 300


def save(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")


def grade(text: str, expected: dict[str, str | int]) -> bool:
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    try:
        answer = json.loads(text)
    except json.JSONDecodeError:
        return False
    if not isinstance(answer, dict) or answer.keys() != expected.keys():
        return False
    for key, value in expected.items():
        actual = answer[key]
        if type(actual) is not type(value):
            return False
        if key == "instruction" and isinstance(actual, str) and isinstance(value, str):
            if re.sub(r"\s+", "", actual) != re.sub(r"\s+", "", value):
                return False
        elif actual != value:
            return False
    return True


def run(
    root: Path,
    fixtures: Path | None,
    image: str,
    cache_mode: str = "disabled",
    repetitions: int = 2,
) -> None:
    if cache_mode not in {"default", "disabled"} or repetitions < 1:
        raise ValueError("Choose a supported cache mode and positive repetition count")
    root = root.resolve()
    if root == REPO or REPO in root.parents or root.exists():
        raise ValueError("Use a fresh evidence directory outside the repository")
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=REPO):
        raise ValueError("Commit the harness and production changes first")
    if os.environ.get("JEV_EVAL_AUTH_MODE") != "subscription":
        raise ValueError("This cohort requires official subscription authentication")
    os.environ["EVIDENCE_DIR"] = str(root)
    source_auth = subscription_mounts()[0]["source"]
    if not os.environ.get("TYPESAFE_API_KEY"):
        raise ValueError("Inject TYPESAFE_API_KEY before execution")
    production = production_root(REPO)
    pin = source_hashes()
    root.mkdir()
    (root / "fixtures").mkdir()
    rows: list[dict] = []
    cases = (
        CASES
        if fixtures
        else {name: (case.question, case.expected) for name, case in WORKLOADS.items()}
    )
    tools = ["Bash", "Read", "Grep"] + ([] if fixtures else ["Edit"])
    for repetition in range(1, repetitions + 1):
        for index, (name, (question, expected)) in enumerate(cases.items()):
            arms = (
                ["control", "plugin"]
                if (index + repetition) % 2
                else ["plugin", "control"]
            )
            initial = EMIT if fixtures else WORKLOADS[name].command
            prompt = (
                f"First run exactly `{initial}` in Bash, without filtering or redirection. "
                "Use visible output directly when it is sufficient. Read saved output only "
                "when a required detail is missing or ambiguous; briefly state which detail "
                "you need before doing so. Additional verification commands are allowed. "
                "Do not inspect the emitter, plugin, evaluation code, configuration outside "
                "the project, /fixture or /logs. "
                + ("Do not change files. " if fixtures else "")
                + f"{question} Return only a JSON object as the final answer, no explanation. "
                + f"Required keys and types: {json.dumps({k: type(v).__name__ for k, v in expected.items()})}."
            )
            for arm in arms:
                rows.append(
                    {
                        "fixture": name,
                        "repetition": repetition,
                        "arm": arm,
                        "job_name": f"{name}-r{repetition}-{arm}",
                        "prompt": prompt,
                        "expected": expected,
                        "state": "pending",
                        "phase": "trial",
                        "command": initial,
                        "cache_mode": cache_mode,
                    }
                )
    declared_fixtures = (
        {
            item["name"]: item
            for item in json.loads((fixtures / "protocol.json").read_text())["fixtures"]
        }
        if fixtures
        else {}
    )
    hashes: dict[str, str | dict[str, str]] = {}
    if not fixtures:
        prepare_workloads(root / "fixtures")
    for name in cases:
        destination = root / "fixtures" / name
        if not fixtures:
            hashes[name] = {
                str(path.relative_to(destination)): hashlib.sha256(
                    path.read_bytes()
                ).hexdigest()
                for path in sorted(destination.rglob("*"))
                if path.is_file()
            }
            continue
        destination.mkdir()
        shutil.copyfile(fixtures / f"{name}.txt", destination / "output.txt")
        (destination / "emit.cjs").write_text(
            "process.stdout.write(require('node:fs').readFileSync('/fixture/output.txt'));\n"
        )
        hashes[name] = hashlib.sha256(
            (destination / "output.txt").read_bytes()
        ).hexdigest()
        if (
            hashes[name] != declared_fixtures[name]["sha256"]
            or declared_fixtures[name]["estimatedTokens"] <= 10_000
        ):
            raise ValueError(
                f"Fixture does not match an above-threshold preflight: {name}"
            )
    settings = {
        "enabledPlugins": {"plugin-authoring@builtin": False},
        "forceLoginMethod": "claudeai",
    }
    startup = [
        {
            "fixture": next(iter(cases)),
            "repetition": 0,
            "arm": arm,
            "job_name": f"startup-{arm}",
            "phase": "startup",
            "state": "pending",
            "command": "printf 'cache-control-startup-check\\n'",
            "prompt": "Run exactly `printf 'cache-control-startup-check\\n'` in Bash. "
            'Then return only {"ready":true}.',
            "expected": {"ready": True},
            "cache_mode": cache_mode,
        }
        for arm in (
            ["control", "plugin"] if cache_mode == "default" else ["plugin", "control"]
        )
    ]
    save(
        root / "protocol.json",
        {
            "declared_at": datetime.now(UTC).isoformat(),
            "purpose": "Exploratory retention/recovery comparison, not Terminal-Bench.",
            "suite": "emitted-fixtures"
            if fixtures
            else "real-commands-constructed-projects",
            "harness_commit": subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=REPO, text=True
            ).strip(),
            "production_commit": subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=production, text=True
            ).strip(),
            "source_sha256": pin,
            "fixture_sha256": hashes,
            "image": image,
            "image_id": subprocess.check_output(
                ["docker", "image", "inspect", image, "--format", "{{.Id}}"], text=True
            ).strip(),
            "claude_version": "2.1.274",
            "model": "claude-sonnet-5",
            "effort": "high",
            "max_turns": 12,
            "cli_model_price_budget_usd_per_trial": 1,
            "timeout_seconds": TIMEOUT,
            "concurrency": 1,
            "repetitions": repetitions,
            "cache_mode": cache_mode,
            "cache_environment": {"DISABLE_PROMPT_CACHING": "1"}
            if cache_mode == "disabled"
            else {},
            "cache_acceptance": "Disabled runs require zero cache-read and cache-creation tokens in every result.",
            "startup": startup,
            "grading": {
                "task_success": "Executable verifier plus unchanged protected files for repairs; factual answer otherwise.",
                "factual_pass": "One JSON object; exact values/types; prose/fences allowed; only declared aliases.",
                "format_pass": "Bare JSON with exact keys/types, independent of values.",
                "legacy_strict": "Original cohort grader retained separately.",
                "aliases": {"cache-build": {"ERROR": "diagnostic"}},
            },
            "auth": "official Claude Max subscription",
            "environment": "local Docker",
            "harbor": "not used",
            "modal": "not used",
            "retries": 0,
            "tools": tools,
            "plugin_options": plugin_options(),
            "limitations": [
                "Small constructed projects and a standard-library reference task; not a real-world benchmark.",
                "Disabled caching is a diagnostic condition, not representative production pricing.",
                "Default caching is shared; balanced arm order and startup calls cannot guarantee identical caches.",
                "CLI model-price estimates are not Claude Max subscription charges.",
                "Archive detection covers explicit paths, not all indirect reads.",
                "Initial repair commands print their real exit status and return normally to expose structured Bash records to the hook. Throwing tool errors are still bypassed.",
            ],
            "trials": rows,
        },
    )
    prelude = (
        "unset CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC "
        + " ".join(AUTH_OVERRIDES)
        + f"; export CLAUDE_CONFIG_DIR={AUTH_RUNTIME}; "
        + prepare_subscription("/logs/agent")
        + " || exit 1; node /check-auth.cjs > /logs/agent/auth-status.json;"
        + ' test "$(claude --version)" = "2.1.274 (Claude Code)" || exit 1; '
    )
    all_rows = startup + rows
    for row in all_rows:
        if source_hashes() != pin:
            raise RuntimeError("Sources changed during inference")
        trial = root / row["job_name"]
        trial.mkdir()
        row["state"] = "running"
        save(root / "results.json", all_rows)
        arm_settings = dict(settings)
        flags = ["--plugin-dir", "/observer"]
        if row["arm"] == "plugin":
            flags += ["--plugin-dir", "/production"]
            arm_settings["pluginConfigs"] = {
                "fast-jev-output@inline": {"options": plugin_options()}
            }
        container = (
            "jev-retention-" + hashlib.sha256(str(trial).encode()).hexdigest()[:16]
        )
        command = [
            "docker",
            "run",
            "--rm",
            "--name",
            container,
            "--workdir",
            "/workspace",
            "--mount",
            f"type=bind,src={source_auth},dst=/opt/jev-eval/login,readonly",
            "--mount",
            f"type=bind,src={trial},dst=/logs/agent",
            "--mount",
            f"type=bind,src={root / 'fixtures' / row['fixture']},dst=/fixture,readonly",
            "--mount",
            f"type=bind,src={REPO / 'evals/observer'},dst=/observer,readonly",
            "--mount",
            f"type=bind,src={REPO / 'evals/check_auth.cjs'},dst=/check-auth.cjs,readonly",
            "--env",
            "TYPESAFE_API_KEY",
            "--env",
            "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1",
            "--env",
            "DISABLE_TELEMETRY=1",
            "--env",
            "DISABLE_ERROR_REPORTING=1",
            "--env",
            "DISABLE_AUTOUPDATER=1",
            "--env",
            "IS_SANDBOX=1",
        ]
        if cache_mode == "disabled":
            command += ["--env", "DISABLE_PROMPT_CACHING=1"]
        script = prelude + 'exec claude "$@"'
        if not fixtures:
            workspace = trial / "workspace"
            shutil.copytree(root / "fixtures" / row["fixture"] / "project", workspace)
            command += [
                "--mount",
                f"type=bind,src={workspace},dst=/workspace",
                "--mount",
                f"type=bind,src={REPO / 'node_modules'},dst=/opt/tools/node_modules,readonly",
            ]
            case = WORKLOADS[row["fixture"]]
            if case.verify and row["phase"] == "trial":
                script = (
                    prelude
                    + 'set +e; claude "$@"; status=$?; '
                    + f"( {case.verify} ) > /logs/agent/verification.txt 2>&1; "
                    + 'printf "%s\\n" "$?" > /logs/agent/verification-exit.txt; exit "$status"'
                )
        for directory in PRODUCTION:
            command += [
                "--mount",
                f"type=bind,src={production / directory},dst=/production/{directory},readonly",
            ]
        command += [
            image,
            "bash",
            "-ec",
            script,
            "--",
            "-p",
            row["prompt"],
            "--model",
            "claude-sonnet-5",
            "--max-budget-usd",
            "1",
            "--max-turns",
            "12",
            "--effort",
            "high",
            "--verbose",
            "--output-format",
            "stream-json",
            "--permission-mode",
            "bypassPermissions",
            "--setting-sources",
            "",
            "--strict-mcp-config",
            "--tools",
            ",".join(tools),
            "--settings",
            json.dumps(arm_settings),
            *flags,
        ]
        started = time.monotonic()
        with (
            (trial / "events.jsonl").open("w") as stdout,
            (trial / "stderr.txt").open("w") as stderr,
        ):
            try:
                completed = subprocess.run(
                    command, stdout=stdout, stderr=stderr, timeout=TIMEOUT, check=False
                )
                row["return_code"] = completed.returncode
            except subprocess.TimeoutExpired:
                subprocess.run(
                    ["docker", "rm", "-f", container], capture_output=True, check=False
                )
                row["return_code"] = 124
        events = read_events(trial / "events.jsonl")
        final = next(
            (event for event in reversed(events) if event.get("type") == "result"), {}
        )
        first_bash = trial / "jev/bash-1.json"
        row["initial_command_matches"] = (
            first_bash.exists()
            and json.loads(first_bash.read_text())["command"].strip() == row["command"]
        )
        row.update(summarize_agent(trial, row["arm"], "events.jsonl"))
        row["final_answer"] = final.get("result", "")
        row.update(
            score_answer(
                row["final_answer"],
                row["expected"],
                {"ERROR": "diagnostic"} if row["fixture"] == "cache-build" else None,
            )
        )
        row["legacy_strict"] = grade(row["final_answer"], row["expected"])
        eligible = bool(
            row["initial_command_matches"]
            and row["return_code"] == 0
            and final.get("subtype") == "success"
        )
        row["task_success"] = eligible and row["factual_pass"]
        if (
            not fixtures
            and row["phase"] == "trial"
            and WORKLOADS[row["fixture"]].verify
        ):
            case = WORKLOADS[row["fixture"]]
            immutable = {
                str(
                    path.relative_to(root / "fixtures" / row["fixture"] / "project")
                ): path
                for path in (root / "fixtures" / row["fixture"] / "project").rglob("*")
                if path.is_file()
                and str(
                    path.relative_to(root / "fixtures" / row["fixture"] / "project")
                )
                != case.editable
            }
            row["protected_files_unchanged"] = all(
                (trial / "workspace" / name).is_file()
                and (trial / "workspace" / name).read_bytes() == path.read_bytes()
                for name, path in immutable.items()
            )
            verification = trial / "verification-exit.txt"
            row["verifier_pass"] = (
                verification.exists() and verification.read_text().strip() == "0"
            )
            row["task_success"] = (
                eligible and row["verifier_pass"] and row["protected_files_unchanged"]
            )
        usage = row["claude_all_models_usage"]
        row["cache_control_valid"] = (
            bool(final.get("modelUsage"))
            and (usage.get("inputTokens", 0) + usage.get("outputTokens", 0) > 0)
            and (
                cache_mode == "default"
                or (
                    usage["cacheReadInputTokens"] == 0
                    and usage["cacheCreationInputTokens"] == 0
                )
            )
        )
        row["legacy_success"] = eligible and row["legacy_strict"]
        row["success"] = row["task_success"]
        row["elapsed_seconds"] = time.monotonic() - started
        row["state"] = "finished"
        save(trial / "summary.json", row)
        save(root / "results.json", all_rows)
        print(
            json.dumps(
                {
                    key: row[key]
                    for key in (
                        "job_name",
                        "success",
                        "pruned_outputs",
                        "archive_access_count",
                        "claude_cost_usd_reported",
                        "measurement_issues",
                    )
                }
            ),
            flush=True,
        )
        if not row["cache_control_valid"] or (
            row["phase"] == "startup" and not row["task_success"]
        ):
            save(
                root / "blocked.json",
                {
                    "reason": access_blocker(events) or "Startup/cache control failed",
                    "trial": row["job_name"],
                },
            )
            raise RuntimeError(
                f"Startup/cache control failed; no retry: {row['job_name']}"
            )
        blocker = access_blocker(events)
        if blocker or row["measurement_issues"]:
            save(
                root / "blocked.json",
                {
                    "reason": blocker or row["measurement_issues"],
                    "trial": row["job_name"],
                },
            )
            return
    save(root / "finished.json", {"finished_at": datetime.now(UTC).isoformat()})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("evidence", type=Path)
    parser.add_argument(
        "--fixtures",
        type=Path,
        help="Omit to execute the constructed repair/reference tasks",
    )
    parser.add_argument("--image", default="jev-retention:2.1.274")
    parser.add_argument(
        "--cache-mode", choices=["default", "disabled"], default="disabled"
    )
    parser.add_argument("--repetitions", type=int, default=2)
    args = parser.parse_args()
    run(args.evidence, args.fixtures, args.image, args.cache_mode, args.repetitions)
