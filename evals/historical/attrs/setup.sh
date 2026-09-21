#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="$(realpath "${1:?usage: setup.sh WORKSPACE VENV}")"
VENV="$(realpath -m "${2:?usage: setup.sh WORKSPACE VENV}")"
test -f "$WORKSPACE/src/attr/_make.py"
test -f "$WORKSPACE/pyproject.toml"

if [[ ! -x "$VENV/bin/python" ]]; then
    python3.12 -m venv "$VENV"
fi
PYTHON="$VENV/bin/python"
"$PYTHON" -c 'import sys; assert sys.version_info[:2] == (3, 12), sys.version'

PINS=(
    pip==25.0.1
    cloudpickle==3.1.1
    decorator==5.2.1
    execnet==2.1.1
    hatch-fancy-pypi-readme==24.1.0
    hatch-vcs==0.4.0
    hatchling==1.27.0
    hypothesis==6.129.4
    iniconfig==2.1.0
    jinja2==3.1.6
    jsonschema==4.23.0
    jsonschema-specifications==2024.10.1
    markupsafe==3.0.2
    mypy==1.11.2
    mypy-extensions==1.0.0
    packaging==24.2
    pathspec==0.12.1
    pluggy==1.5.0
    psutil==7.0.0
    pympler==1.1
    pytest==8.3.5
    pytest-mypy-plugins==3.2.0
    pytest-xdist==3.6.1
    pyyaml==6.0.2
    referencing==0.36.2
    regex==2024.11.6
    rpds-py==0.23.1
    setuptools==75.8.2
    setuptools-scm==8.2.0
    sortedcontainers==2.4.0
    tomlkit==0.13.2
    trove-classifiers==2025.3.13.13
    typing-extensions==4.12.2
)

if [[ ! -f "$VENV/.historical-attrs-ready" ]]; then
    "$PYTHON" -m pip install --disable-pip-version-check --only-binary=:all: --no-deps "${PINS[@]}"
fi

"$PYTHON" - "${PINS[@]}" <<'PY'
import importlib.metadata
import sys
import sysconfig
from pathlib import Path

for pin in sys.argv[1:]:
    name, expected = pin.split("==")
    actual = importlib.metadata.version(name)
    if actual != expected:
        raise SystemExit(f"{name}: expected {expected}, found {actual}")
site = Path(sysconfig.get_path("purelib"))
assert not (site / "attr").exists(), "Installed attr would hide workspace defects"
assert not (site / "attrs").exists(), "Installed attrs would hide workspace defects"
assert not list(site.glob("*attrs*.pth")), "Editable attrs installs are not supported"
PY

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$WORKSPACE/src" \
SETUPTOOLS_SCM_PRETEND_VERSION=25.2.0 "$PYTHON" - "$WORKSPACE" <<'PY'
import importlib.metadata
import os
import sys
from pathlib import Path

import attr
import attr._make
import attrs
from hatchling.build import prepare_metadata_for_build_wheel

workspace = Path(sys.argv[1]).resolve()
os.chdir(workspace)
prepare_metadata_for_build_wheel(str(workspace / "src"))
for module, relative in (
    (attr, "attr/__init__.py"),
    (attr._make, "attr/_make.py"),
    (attrs, "attrs/__init__.py"),
):
    actual = Path(module.__file__).resolve()
    assert actual == workspace / "src" / relative, actual
    print(f"{module.__name__} source: {actual}")
assert importlib.metadata.version("attrs") == "25.2.0"
PY

PYTHONPATH="$WORKSPACE/src" "$PYTHON" -m pip check
touch "$VENV/.historical-attrs-ready"
