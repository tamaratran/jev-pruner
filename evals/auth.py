"""Subscription credentials stay in private container storage, outside evidence."""

import hashlib
import json
import math
import os
import shlex
import stat
import time
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


def credential_state(path: Path) -> tuple[bytes, float]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 1_048_576:
        raise ValueError("Invalid private subscription file")
    data = path.read_bytes()
    try:
        document = json.loads(data)
        oauth = document["claudeAiOauth"]
        expires = oauth["expiresAt"]
        if (
            not isinstance(expires, (int, float))
            or isinstance(expires, bool)
            or not math.isfinite(expires)
            or any(
                not isinstance(oauth.get(key), str) or not oauth[key]
                for key in ("accessToken", "refreshToken")
            )
        ):
            raise ValueError
    except (ValueError, KeyError, TypeError):
        raise ValueError("Invalid subscription refresh state") from None
    return data, float(expires)


class SubscriptionCheckpoint:
    def __init__(self, path: Path):
        if (
            stat.S_IMODE(path.stat().st_mode) != 0o600
            or stat.S_IMODE(path.parent.stat().st_mode) != 0o700
            or path.stat().st_uid != os.getuid()
        ):
            raise ValueError("Subscription checkpoint requires private owned storage")
        data, self.expires_at = credential_state(path)
        self.path = path
        self.digest = hashlib.sha256(data).digest()

    def restore(self, downloaded: Path) -> dict:
        data, expires_at = credential_state(downloaded)
        if expires_at <= time.time() * 1000:
            raise ValueError("Runtime subscription state is expired")
        if expires_at < self.expires_at:
            raise ValueError("Controller subscription changed during trial")
        current, _ = credential_state(self.path)
        if hashlib.sha256(current).digest() != self.digest:
            raise ValueError("Controller subscription changed during trial")
        changed = data != current
        if changed:
            downloaded.chmod(0o600)
            with downloaded.open("rb") as stream:
                os.fsync(stream.fileno())
            os.replace(downloaded, self.path)
            descriptor = os.open(self.path.parent, os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        self.digest = hashlib.sha256(data).digest()
        self.expires_at = expires_at
        return {"changed": changed, "expires_at": expires_at}


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
