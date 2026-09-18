"""Subscription credentials stay in private container storage, outside evidence."""

import json
import os
import shlex
from pathlib import Path

AUTH_MOUNT = "/opt/jev-eval/login"
AUTH_RUNTIME = "/opt/jev-eval/auth"
AUTH_OVERRIDES = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "AWS_BEARER_TOKEN_BEDROCK",
)


def auth_mode() -> str:
    mode = os.environ.get("JEV_EVAL_AUTH_MODE", "api")
    if mode not in {"api", "subscription"}:
        raise ValueError("JEV_EVAL_AUTH_MODE must be api or subscription")
    return mode


def subscription_source() -> Path:
    source = Path(os.environ["JEV_EVAL_CLAUDE_AUTH_DIR"]).expanduser().resolve()
    if not (source / ".credentials.json").is_file():
        raise ValueError("Complete official Claude login in the auth directory first")
    evidence = Path(os.environ["EVIDENCE_DIR"]).expanduser().resolve()
    repo = Path(__file__).resolve().parents[1]
    if source.is_relative_to(evidence) or source.is_relative_to(repo):
        raise ValueError(
            "Keep the private auth directory outside evidence and the repo"
        )
    return source


def subscription_mounts() -> list[dict]:
    source = subscription_source()
    return [
        {
            "type": "bind",
            "source": str(source),
            "target": AUTH_MOUNT,
            "read_only": True,
            "bind": {"create_host_path": False},
        }
    ]


def prepare_subscription(logs_dir: str) -> str:
    projects = shlex.quote(f"{logs_dir}/sessions/projects")
    return (
        f"test ! -e {AUTH_RUNTIME} && "
        f"test -s {AUTH_MOUNT}/.credentials.json && "
        f"mkdir -m 700 {AUTH_RUNTIME} && "
        f"install -m 600 {AUTH_MOUNT}/.credentials.json {AUTH_RUNTIME}/ && "
        f"if [ -f {AUTH_MOUNT}/.claude.json ]; then "
        f"install -m 600 {AUTH_MOUNT}/.claude.json {AUTH_RUNTIME}/; fi && "
        f"mkdir -p {projects} && ln -s {projects} {AUTH_RUNTIME}/projects"
    )


if __name__ == "__main__":
    print(json.dumps(subscription_mounts()))
