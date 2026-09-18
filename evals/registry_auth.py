"""Private controller-only Docker Hub credentials."""

import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, repr=False)
class RegistryCredentials:
    username: str
    token: str


def registry_credentials() -> RegistryCredentials | None:
    location = os.environ.get("JEV_EVAL_DOCKER_AUTH_FILE")
    if not location:
        return None
    path = Path(location).expanduser()
    resolved = path.resolve()
    protected = [Path(__file__).resolve().parents[1]]
    if evidence := os.environ.get("EVIDENCE_DIR"):
        protected.append(Path(evidence).resolve())
    if any(resolved.is_relative_to(root) for root in protected):
        raise ValueError("Registry credentials must be outside repository and evidence")
    if (
        path.is_symlink()
        or not path.is_file()
        or stat.S_IMODE(path.stat().st_mode) != 0o600
        or stat.S_IMODE(path.parent.stat().st_mode) != 0o700
        or path.stat().st_uid != os.getuid()
    ):
        raise ValueError("Registry credentials require an owned private file/directory")
    try:
        value = json.loads(path.read_text())
    except (ValueError, OSError):
        raise ValueError("Cannot read private registry credentials") from None
    if (
        not isinstance(value, dict)
        or set(value) != {"username", "token"}
        or not isinstance(value["username"], str)
        or not isinstance(value["token"], str)
        or not value["username"]
        or not value["token"]
        or ":" in value["username"]
        or any(c.isspace() for c in value["username"] + value["token"])
    ):
        raise ValueError("Invalid private registry credentials")
    return RegistryCredentials(value["username"], value["token"])
