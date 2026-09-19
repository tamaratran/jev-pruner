#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "Usage: $0 WORKSPACE VENV" >&2
    exit 2
fi

WORKSPACE="$(realpath "$1")"
VENV="$(realpath -m "$2")"
test -f "$WORKSPACE/src/flask/testing.py"

if [[ ! -x "$VENV/bin/python" ]]; then
    python3.12 -m venv "$VENV"
fi

"$VENV/bin/python" -c 'import sys; assert sys.version_info[:2] == (3, 12), sys.version'

pins=(
    pip==25.1.1
    flit_core==3.12.0
    asgiref==3.8.1
    blinker==1.9.0
    click==8.2.1
    greenlet==3.2.3
    iniconfig==2.1.0
    itsdangerous==2.2.0
    jinja2==3.1.6
    markupsafe==3.0.2
    packaging==25.0
    pluggy==1.6.0
    pygments==2.19.1
    pytest==8.4.0
    python-dotenv==1.1.0
    werkzeug==3.1.3
)

if ! "$VENV/bin/python" - "${pins[@]}" <<'PY'
import importlib.metadata
import sys

for requirement in sys.argv[1:]:
    name, expected = requirement.split("==")
    try:
        actual = importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        sys.exit(1)
    if actual != expected:
        sys.exit(1)
PY
then
    "$VENV/bin/python" -m pip install --disable-pip-version-check \
        --only-binary=:all: --no-deps "${pins[@]}"
fi

"$VENV/bin/python" -m pip check

cd "$WORKSPACE"
"$VENV/bin/python" - <<'PY'
from flit_core.buildapi import prepare_metadata_for_build_wheel

prepare_metadata_for_build_wheel("src")
PY

PYTHONPATH="$WORKSPACE/src" "$VENV/bin/python" - "$WORKSPACE" <<'PY'
import importlib.metadata
import pathlib
import sys

import flask
import flask.testing

workspace = pathlib.Path(sys.argv[1]).resolve()
assert pathlib.Path(flask.__file__).resolve() == workspace / "src/flask/__init__.py"
assert pathlib.Path(flask.testing.__file__).resolve() == workspace / "src/flask/testing.py"
assert importlib.metadata.version("flask") == "3.1.2.dev0"
print(f"Flask source: {flask.__file__}")
PY
