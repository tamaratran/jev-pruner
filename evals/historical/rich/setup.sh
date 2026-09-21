#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="$(realpath "${1:?usage: setup.sh WORKSPACE VENV}")"
VENV="$(realpath -m "${2:?usage: setup.sh WORKSPACE VENV}")"
test -f "$WORKSPACE/rich/__init__.py"
test -f "$WORKSPACE/pyproject.toml"

PINS=(
    pip==25.0.1
    pytest==7.4.4
    iniconfig==2.0.0
    packaging==24.2
    pluggy==1.5.0
    Pygments==2.19.1
    markdown-it-py==3.0.0
    mdurl==0.1.2
)

if [[ ! -e "$VENV" ]]; then
    python3.12 -m venv "$VENV"
    "$VENV/bin/python" -m pip install --disable-pip-version-check --no-deps "${PINS[@]}"
fi

PYTHON="$VENV/bin/python"
"$PYTHON" - "${PINS[@]}" <<'PY'
import importlib.metadata
import re
import sys

assert sys.version_info[:2] == (3, 12), sys.version


def normalize(name):
    return re.sub(r"[-_.]+", "-", name).lower()


expected = {
    normalize(name): version
    for name, version in (pin.split("==") for pin in sys.argv[1:])
}
actual = {
    normalize(distribution.metadata["Name"]): distribution.version
    for distribution in importlib.metadata.distributions()
}
assert actual == expected, f"Venv dependencies differ: expected {expected}, found {actual}"
PY

ln -sfn "$VENV" "$WORKSPACE/.historical-venv"

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$WORKSPACE" "$PYTHON" - "$WORKSPACE" <<'PY'
import pathlib
import sys

import rich
import rich.console
import rich.markup
import rich.prompt

root = pathlib.Path(sys.argv[1]).resolve()
for module in (rich, rich.console, rich.markup, rich.prompt):
    source = pathlib.Path(module.__file__).resolve()
    assert source.is_relative_to(root / "rich"), (module.__name__, source)
    print(f"{module.__name__}: {source}")
PY
