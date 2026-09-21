#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="$(realpath "${1:?usage: setup.sh WORKSPACE VENV}")"
VENV="$(realpath -m "${2:?usage: setup.sh WORKSPACE VENV}")"
test -f "$WORKSPACE/src/requests/__init__.py"
test -f "$WORKSPACE/pyproject.toml"

PINS=(
    pip==25.0.1
    pytest==6.2.5
    attrs==23.2.0
    iniconfig==2.0.0
    packaging==23.2
    pluggy==1.3.0
    py==1.11.0
    toml==0.10.2
    certifi==2024.2.2
    charset-normalizer==3.3.2
    idna==3.6
    urllib3==2.2.1
)

if [[ ! -e "$VENV" ]]; then
    python3.12 -m venv "$VENV"
    "$VENV/bin/python" -m pip install --disable-pip-version-check \
        --only-binary=:all: --no-deps "${PINS[@]}"
fi

PYTHON="$VENV/bin/python"
"$PYTHON" - "${PINS[@]}" <<'PY'
import importlib.metadata
import re
import sys

assert sys.version_info[:2] == (3, 12), sys.version

def normalize(name):
    return re.sub(r"[-_.]+", "-", name).lower()

expected = dict(pin.split("==") for pin in sys.argv[1:])
actual = {
    normalize(distribution.metadata["Name"]): distribution.version
    for distribution in importlib.metadata.distributions()
}
assert actual == expected, f"Existing venv does not match pinned dependencies: {actual}"
PY

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$WORKSPACE/src" "$PYTHON" - "$WORKSPACE" <<'PY'
import pathlib
import sys

import requests
import requests.adapters

root = pathlib.Path(sys.argv[1]).resolve() / "src" / "requests"
assert pathlib.Path(requests.__file__).resolve() == root / "__init__.py"
assert pathlib.Path(requests.adapters.__file__).resolve() == root / "adapters.py"
print(f"Requests source: {requests.__file__}")
print(f"HTTP adapter source: {requests.adapters.__file__}")
PY
