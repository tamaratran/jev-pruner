"""Select a production checkout independently of the evaluation harness."""

import os
import subprocess
from pathlib import Path

PRODUCTION = (".claude-plugin", "hooks", "src")


def plugin_options() -> dict[str, int | bool]:
    options: dict[str, int | bool] = {}
    diagnostics = os.environ.get("JEV_EVAL_DIAGNOSTICS", "0")
    if diagnostics not in {"0", "1"}:
        raise ValueError("JEV_EVAL_DIAGNOSTICS must be 0 or 1")
    if diagnostics == "1":
        options["diagnostics"] = True
    target = os.environ.get("JEV_EVAL_CHUNK_CHARS")
    if target is not None:
        value = int(target)
        if value < 0:
            raise ValueError("JEV_EVAL_CHUNK_CHARS must be nonnegative")
        options["chunkChars"] = value
    return options


def production_root(repo: Path) -> Path:
    value = os.environ.get("JEV_EVAL_PLUGIN_DIR")
    if not value:
        return repo
    root = Path(value)
    if not root.is_absolute() or not all((root / name).is_dir() for name in PRODUCTION):
        raise ValueError("JEV_EVAL_PLUGIN_DIR must be an absolute plugin checkout")
    return root.resolve()


def production_provenance(repo: Path) -> dict[str, str]:
    if not os.environ.get("JEV_EVAL_PLUGIN_DIR"):
        return {}
    root = production_root(repo)
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=root):
        raise ValueError("Commit production checkout changes before execution")
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()
    return {"production_checkout": str(root), "production_commit": commit}
