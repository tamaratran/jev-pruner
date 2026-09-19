#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "Usage: $0 WORKSPACE VENV" >&2
    exit 2
fi
workspace=$(realpath "$1")
venv=$(realpath -m "$2")
test -f "$workspace/src/pip/_internal/req/constructors.py"
test -f "$workspace/tests/unit/test_req.py"

if [[ ! -x "$venv/bin/python" ]]; then
    python3.12 -m venv "$venv"
fi
"$venv/bin/python" -I -c 'import sys; assert sys.version_info[:2] == (3, 12), sys.version'

pins=(
    pip==25.1.1
    pytest==8.3.5
    pytest-subket==0.8.1
    installer==0.7.0
    scripttest==2.0.post1
    virtualenv==20.31.2
    Werkzeug==3.1.3
    setuptools==79.0.1
    wheel==0.45.1
    iniconfig==2.1.0
    packaging==25.0
    pluggy==1.5.0
    distlib==0.3.9
    filelock==3.18.0
    platformdirs==4.3.8
    MarkupSafe==3.0.2
)
check_pins() {
    "$venv/bin/python" -I - "${pins[@]}" <<'PY'
import sys
from importlib.metadata import PackageNotFoundError, version

try:
    matches = all(version(name) == wanted for name, wanted in
                  (pin.split("==") for pin in sys.argv[1:]))
except PackageNotFoundError:
    matches = False
sys.exit(0 if matches else 1)
PY
}
if ! check_pins; then
    PIP_CONFIG_FILE=/dev/null PIP_NO_INDEX=0 PIP_FIND_LINKS= \
        "$venv/bin/python" -I -m pip --disable-pip-version-check install \
        --only-binary=:all: --no-deps "${pins[@]}"
fi
check_pins
"$venv/bin/python" -I -m pip --disable-pip-version-check check

wheelhouse="$venv/historical-pip-wheels"
mkdir -p "$wheelhouse"
if [[ ! -f "$wheelhouse/setuptools-79.0.1-py3-none-any.whl" ||
      ! -f "$wheelhouse/wheel-0.45.1-py3-none-any.whl" ]]; then
    PIP_CONFIG_FILE=/dev/null PIP_NO_INDEX=0 PIP_FIND_LINKS= \
        "$venv/bin/python" -I -m pip --disable-pip-version-check download \
        --only-binary=:all: --no-deps --dest "$wheelhouse" \
        setuptools==79.0.1 wheel==0.45.1
fi
mkdir -p "$workspace/tests/data/common_wheels"
cp "$wheelhouse/setuptools-79.0.1-py3-none-any.whl" \
    "$wheelhouse/wheel-0.45.1-py3-none-any.whl" \
    "$workspace/tests/data/common_wheels/"

cd "$workspace"
PYTHONPATH="$workspace/src" "$venv/bin/python" - "$workspace" <<'PY'
import sys
from pathlib import Path

import pip
from pip._internal.req import constructors

source = Path(sys.argv[1]).resolve() / "src"
assert Path(pip.__file__).resolve() == source / "pip/__init__.py"
assert Path(constructors.__file__).resolve() == source / "pip/_internal/req/constructors.py"
print(f"Workspace pip source: {pip.__file__}")
PY
