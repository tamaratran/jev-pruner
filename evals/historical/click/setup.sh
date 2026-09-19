#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="$(realpath "${1:?usage: setup.sh WORKSPACE VENV}")"
VENV="$(realpath -m "${2:?usage: setup.sh WORKSPACE VENV}")"
test -f "$WORKSPACE/src/click/__init__.py"
test -f "$WORKSPACE/pyproject.toml"

if [[ ! -x "$VENV/bin/python" ]]; then
    python3.12 -m venv "$VENV"
fi

PYTHON="$VENV/bin/python"
"$PYTHON" -c 'import sys; assert sys.version_info[:2] == (3, 12), sys.version'

PINS=(
    pip==25.0.1
    pytest==8.3.5
    iniconfig==2.1.0
    packaging==24.2
    pluggy==1.5.0
)

if [[ ! -f "$VENV/.historical-click-ready" ]]; then
    "$PYTHON" -m pip install --disable-pip-version-check --no-deps "${PINS[@]}"
fi

"$PYTHON" - "${PINS[@]}" <<'PY'
import importlib.metadata
import sys

for pin in sys.argv[1:]:
    name, expected = pin.split("==")
    actual = importlib.metadata.version(name)
    if actual != expected:
        raise SystemExit(f"{name}: expected {expected}, found {actual}")
PY

touch "$VENV/.historical-click-ready"
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$WORKSPACE/src" "$PYTHON" - "$WORKSPACE" <<'PY'
import pathlib
import sys

import click
import click.termui

root = pathlib.Path(sys.argv[1]).resolve() / "src" / "click"
assert pathlib.Path(click.__file__).resolve() == root / "__init__.py"
assert pathlib.Path(click.termui.__file__).resolve() == root / "termui.py"
print(f"Click source: {click.__file__}")
PY
