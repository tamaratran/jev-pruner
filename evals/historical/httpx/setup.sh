#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "Usage: $0 WORKSPACE VENV" >&2
    exit 2
fi

WORKSPACE="$(realpath "$1")"
VENV="$(realpath -m "$2")"
test -f "$WORKSPACE/httpx/_decoders.py"
export PYTHONDONTWRITEBYTECODE=1

if [[ ! -x "$VENV/bin/python" ]]; then
    python3.12 -m venv "$VENV"
fi

"$VENV/bin/python" -c 'import sys; assert sys.version_info[:2] == (3, 12), sys.version'

pins=(
    pip==25.1.1
    anyio==4.6.2.post1
    attrs==24.2.0
    brotli==1.1.0
    certifi==2024.8.30
    cffi==1.17.1
    chardet==5.2.0
    click==8.1.7
    cryptography==43.0.1
    h11==0.14.0
    httpcore==1.0.7
    idna==3.10
    iniconfig==2.0.0
    outcome==1.3.0.post0
    packaging==24.1
    pluggy==1.5.0
    pycparser==2.22
    pytest==8.3.3
    sniffio==1.3.1
    sortedcontainers==2.4.0
    trio==0.26.2
    trustme==1.1.0
    typing_extensions==4.12.2
    uvicorn==0.31.0
    zstandard==0.23.0
)

state="$("$VENV/bin/python" - "${pins[@]}" <<'PY'
import importlib.metadata
import re
import sys


def normalized(name):
    return re.sub(r"[-_.]+", "-", name).lower()


expected = dict(requirement.split("==") for requirement in sys.argv[1:])
expected = {normalized(name): version for name, version in expected.items()}
actual = {
    normalized(dist.metadata["Name"]): dist.version
    for dist in importlib.metadata.distributions()
}
if actual == expected:
    print("ready")
elif set(actual) <= {"pip"}:
    print("bootstrap")
else:
    raise SystemExit("Existing venv does not match HTTPX fixture pins; refusing to change it.")
PY
)"

if [[ "$state" == bootstrap ]]; then
    "$VENV/bin/python" -m pip install --disable-pip-version-check \
        --only-binary=:all: --no-deps "${pins[@]}"
fi

"$VENV/bin/python" -m pip check

cd "$WORKSPACE"
PYTHONPATH="$WORKSPACE" "$VENV/bin/python" - "$WORKSPACE" <<'PY'
import importlib.metadata
import pathlib
import sys

import httpx
import httpx._decoders

workspace = pathlib.Path(sys.argv[1]).resolve()
assert pathlib.Path(httpx.__file__).resolve() == workspace / "httpx/__init__.py"
assert pathlib.Path(httpx._decoders.__file__).resolve() == workspace / "httpx/_decoders.py"
assert httpx.__version__ == "0.27.2"
try:
    importlib.metadata.distribution("httpx")
except importlib.metadata.PackageNotFoundError:
    pass
else:
    raise AssertionError("An installed HTTPX distribution must not shadow the workspace")
print(f"HTTPX source: {httpx.__file__}")
print(f"Decoder source: {httpx._decoders.__file__}")
PY
