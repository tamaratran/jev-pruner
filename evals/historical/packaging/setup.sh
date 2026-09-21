#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="$(realpath "${1:?usage: setup.sh WORKSPACE VENV}")"
VENV="$(realpath -m "${2:?usage: setup.sh WORKSPACE VENV}")"
test -f "$WORKSPACE/src/packaging/markers.py"
test -f "$WORKSPACE/pyproject.toml"

PINS=(
    pip==25.0.1
    pytest==8.3.5
    pretend==1.0.9
    coverage==7.6.1
    iniconfig==2.1.0
    pluggy==1.5.0
    flit_core==3.10.1
)

if [[ ! -e "$VENV" ]]; then
    python3.12 -m venv "$VENV"
    "$VENV/bin/python" -I -m pip install --disable-pip-version-check \
        --only-binary=:all: --no-deps "${PINS[@]}"
fi

PYTHON="$VENV/bin/python"
"$PYTHON" -I - "${PINS[@]}" <<'PY'
import importlib.metadata
import sys

assert sys.version_info[:2] == (3, 12), sys.version
expected = dict(pin.split("==") for pin in sys.argv[1:])
installed = {
    dist.metadata["Name"].lower().replace("-", "_"): dist.version
    for dist in importlib.metadata.distributions()
}
assert installed == expected, (installed, expected)
PY

cd "$WORKSPACE"
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$WORKSPACE/src" "$PYTHON" - "$WORKSPACE" <<'PY'
import importlib.metadata
import pathlib
import sys

import packaging
import packaging.markers
from flit_core.buildapi import prepare_metadata_for_build_wheel

root = pathlib.Path(sys.argv[1]).resolve()
assert pathlib.Path(packaging.__file__).resolve() == root / "src/packaging/__init__.py"
assert pathlib.Path(packaging.markers.__file__).resolve() == root / "src/packaging/markers.py"
prepare_metadata_for_build_wheel(str(root / "src"))
assert importlib.metadata.version("packaging") == packaging.__version__
print(f"Packaging source: {packaging.__file__}")
print(f"Markers source: {packaging.markers.__file__}")
PY

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$WORKSPACE/src" "$PYTHON" -m pip check
