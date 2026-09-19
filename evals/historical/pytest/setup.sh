#!/usr/bin/env bash
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1

WORKSPACE="$(realpath "${1:?usage: setup.sh WORKSPACE VENV}")"
VENV="$(realpath -m "${2:?usage: setup.sh WORKSPACE VENV}")"
test -f "$WORKSPACE/src/_pytest/recwarn.py"

if [[ ! -x "$VENV/bin/python" ]]; then
    python3.12 -m venv "$VENV"
fi

"$VENV/bin/python" -c 'import sys; assert sys.version_info[:2] == (3, 12), sys.version'

DEPS=(
    pip==24.0
    setuptools==69.1.0
    setuptools-scm==8.0.4
    wheel==0.42.0
    typing_extensions==4.9.0
    iniconfig==2.0.0
    packaging==23.2
    pluggy==1.4.0
    Pygments==2.17.2
)

if ! "$VENV/bin/python" - "${DEPS[@]}" <<'PY'
import sys
from importlib.metadata import PackageNotFoundError, version

for spec in sys.argv[1:]:
    name, expected = spec.split("==")
    try:
        actual = version(name)
    except PackageNotFoundError:
        sys.exit(1)
    if actual != expected:
        sys.exit(1)
PY
then
    "$VENV/bin/python" -m pip install --disable-pip-version-check --no-deps "${DEPS[@]}"
fi
"$VENV/bin/python" -m pip check

# An archive has no SCM metadata; generate the normal upstream version module.
SETUPTOOLS_SCM_PRETEND_VERSION=8.1.0.dev197+g6ef0cf150 \
    "$VENV/bin/python" - "$WORKSPACE" <<'PY'
import sys

from setuptools_scm import get_version

get_version(root=sys.argv[1], write_to="src/_pytest/_version.py")
PY

PYTHONPATH="$WORKSPACE/src" "$VENV/bin/python" - "$WORKSPACE" <<'PY'
import sys
from pathlib import Path

import _pytest.recwarn
import pytest

root = Path(sys.argv[1]).resolve() / "src"
assert Path(pytest.__file__).resolve() == root / "pytest/__init__.py"
assert Path(_pytest.recwarn.__file__).resolve() == root / "_pytest/recwarn.py"
print(f"pytest {pytest.__version__}: {pytest.__file__}")
print(f"recwarn: {_pytest.recwarn.__file__}")
PY
