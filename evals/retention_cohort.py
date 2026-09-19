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

from evals.auth import (
    AUTH_OVERRIDES,
    AUTH_RUNTIME,
    prepare_subscription,
    subscription_mounts,
)
from evals.full import REPO, access_blocker, source_hashes
from evals.sources import PRODUCTION, plugin_options, production_root
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


def run(root: Path, fixtures: Path, image: str) -> None:
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
    for repetition in range(1, 4):
        for index, (name, (question, expected)) in enumerate(CASES.items()):
            arms = (
                ["control", "plugin"]
                if (index + repetition) % 2
                else ["plugin", "control"]
            )
            prompt = (
                f"First run exactly `{EMIT}` in Bash, without filtering or redirection. "
                "Use the emitted output to answer the question below. You may read saved output "
                "or use additional tools when needed. Do not inspect the emitter program, "
                "plugin code, evaluation code or configuration. Do not change files. "
                f"{question} Return only a JSON object with those keys, no explanation."
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
                    }
                )
    declared_fixtures = {
        item["name"]: item
        for item in json.loads((fixtures / "protocol.json").read_text())["fixtures"]
    }
    hashes = {}
    for name in CASES:
        destination = root / "fixtures" / name
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
    save(
        root / "protocol.json",
        {
            "declared_at": datetime.now(UTC).isoformat(),
            "purpose": "Exploratory synthetic retention/recovery comparison, not Terminal-Bench.",
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
            "repetitions": 3,
            "auth": "official Claude Max subscription",
            "environment": "local Docker",
            "harbor": "not used",
            "modal": "not used",
            "retries": 0,
            "tools": ["Bash", "Read", "Grep"],
            "plugin_options": plugin_options(),
            "limitations": [
                "Synthetic cases selected during development, not a held-out benchmark.",
                "Shared provider prompt cache; arm order balanced but cache isolation unavailable.",
                "CLI model-price estimates are not Claude Max subscription charges.",
                "Archive detection covers explicit paths, not all indirect reads.",
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
        + ' test "$(claude --version)" = "2.1.274 (Claude Code)" || exit 1; exec claude "$@"'
    )
    for row in rows:
        if source_hashes() != pin:
            raise RuntimeError("Sources changed during inference")
        trial = root / row["job_name"]
        trial.mkdir()
        row["state"] = "running"
        save(root / "results.json", rows)
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
        for directory in PRODUCTION:
            command += [
                "--mount",
                f"type=bind,src={production / directory},dst=/production/{directory},readonly",
            ]
        command += [
            image,
            "bash",
            "-ec",
            prelude,
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
            "Bash,Read,Grep",
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
            and json.loads(first_bash.read_text())["command"].strip() == EMIT
        )
        row.update(summarize_agent(trial, row["arm"], "events.jsonl"))
        row["final_answer"] = final.get("result", "")
        row["success"] = bool(
            row["initial_command_matches"]
            and row["return_code"] == 0
            and final.get("subtype") == "success"
            and grade(row["final_answer"], row["expected"])
        )
        row["elapsed_seconds"] = time.monotonic() - started
        row["state"] = "finished"
        save(trial / "summary.json", row)
        save(root / "results.json", rows)
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
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--image", default="jev-claude-smoke:2.1.274")
    args = parser.parse_args()
    run(args.evidence, args.fixtures, args.image)
