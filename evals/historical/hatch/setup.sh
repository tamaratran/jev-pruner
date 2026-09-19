#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "Usage: $0 WORKSPACE VENV" >&2
    exit 2
fi

workspace=$(realpath "$1")
venv=$(realpath -m "$2")
test -f "$workspace/backend/src/hatchling/metadata/core.py"
test -f "$workspace/tests/backend/metadata/test_core.py"

if [[ ! -x "$venv/bin/python" ]]; then
    python3.12 -m venv "$venv"
fi
"$venv/bin/python" -c 'import sys; assert sys.version_info[:2] == (3, 12), sys.version'

dependencies=(
    "pip==25.0.1"
    "click==8.1.7"
    "filelock==3.13.3"
    "iniconfig==2.0.0"
    "markdown-it-py==3.0.0"
    "mdurl==0.1.2"
    "packaging==24.2"
    "pathspec==0.12.1"
    "platformdirs==4.2.0"
    "pluggy==1.5.0"
    "Pygments==2.17.2"
    "pytest==8.3.5"
    "pytest-mock==3.14.0"
    "rich==13.7.1"
    "tomli-w==1.0.0"
    "tomlkit==0.12.4"
    "trove-classifiers==2024.3.25"
)

if ! "$venv/bin/python" - "${dependencies[@]}" <<'PY'
import sys
from importlib.metadata import PackageNotFoundError, version

for requirement in sys.argv[1:]:
    name, expected = requirement.split("==")
    try:
        installed = version(name)
    except PackageNotFoundError:
        sys.exit(1)
    if installed != expected:
        sys.exit(1)
PY
then
    "$venv/bin/python" -m pip install --disable-pip-version-check --no-deps "${dependencies[@]}"
fi
"$venv/bin/python" -m pip check

PYTHONPATH="$workspace/src:$workspace/backend/src" PYTHONDONTWRITEBYTECODE=1 \
    "$venv/bin/python" - "$workspace" <<'PY'
import sys
from importlib.metadata import PackageNotFoundError, distribution
from pathlib import Path

import hatch.config.user
import hatchling.metadata.core

workspace = Path(sys.argv[1])
assert Path(hatch.config.user.__file__).resolve() == workspace / "src/hatch/config/user.py"
assert Path(hatchling.metadata.core.__file__).resolve() == workspace / "backend/src/hatchling/metadata/core.py"
for name in ("hatch", "hatchling"):
    try:
        distribution(name)
    except PackageNotFoundError:
        continue
    raise RuntimeError(f"Use a venv without an installed {name} distribution")
print(f"Source imports verified: {workspace}")
PY
