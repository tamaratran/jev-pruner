"""Fresh constructed projects executed by real pytest and TypeScript tools."""

import argparse
import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Workload:
    command: str
    question: str
    expected: dict[str, str | int]
    verify: str = ""
    editable: str = ""
    solution: str = ""


TSC = "node /opt/tools/node_modules/typescript/bin/tsc"
WORKLOADS = {
    "pytest-repair": Workload(
        'python3 -m pytest -vv --tb=short; result=$?; printf "\\nExit status: %s\\n" "$result"',
        "Fix cart.total: the LOYAL coupon must subtract 7, not 5. "
        "Only edit cart.py. Do not edit tests. Verify the repair and return "
        'exactly {"fixed":true} if it works, or {"fixed":false} otherwise.',
        {"fixed": True},
        "PYTHONPATH=/workspace python3 -m pytest -q /fixture/oracle/test_cart.py",
        "cart.py",
        'def total(subtotal, coupon=""):\n    return subtotal - 7 if coupon == "LOYAL" else subtotal\n',
    ),
    "typescript-repair": Workload(
        f'{TSC} --listFiles --pretty false; result=$?; printf "\\nExit status: %s\\n" "$result"',
        "Fix the build: config.timeout must be the number 4500. "
        "Only edit src/config.ts. Verify the build and value, then return "
        'exactly {"fixed":true} if it works, or {"fixed":false} otherwise.',
        {"fixed": True},
        f"{TSC} --pretty false && node -e "
        "'if(require(\"./dist/config.js\").timeout!==4500)process.exit(1)'",
        "src/config.ts",
        "export const timeout: number = 4500;\n",
    ),
    "python-reference": Workload(
        "python3 -m pydoc pathlib",
        "Find the Path method that tests whether a path is relative to another "
        "without accessing the filesystem. Return method (unqualified name) "
        "and return_when_relative (boolean).",
        {"method": "is_relative_to", "return_when_relative": True},
    ),
}


def prepare_workloads(root: Path) -> None:
    for name in WORKLOADS:
        (root / name / "project").mkdir(parents=True)
        (root / name / "oracle").mkdir()
    project = root / "pytest-repair" / "project"
    (project / "cart.py").write_text(
        'def total(subtotal, coupon=""):\n'
        '    return subtotal - 5 if coupon == "LOYAL" else subtotal\n'
    )
    tests = (
        "import pytest\nfrom cart import total\n\n"
        '@pytest.mark.parametrize("subtotal", range(1800))\n'
        "def test_regular_total(subtotal):\n    assert total(subtotal) == subtotal\n\n"
        'def test_loyal_coupon():\n    assert total(80, "LOYAL") == 73\n'
    )
    (project / "test_cart.py").write_text(tests)
    (root / "pytest-repair" / "oracle" / "test_cart.py").write_text(tests)
    project = root / "typescript-repair" / "project"
    (project / "src").mkdir()
    (project / "src" / "config.ts").write_text(
        'export const timeout: number = "4500";\n'
    )
    (project / "tsconfig.json").write_text(
        json.dumps(
            {
                "compilerOptions": {
                    "target": "ES2020",
                    "module": "CommonJS",
                    "strict": True,
                    "outDir": "dist",
                    "noEmitOnError": True,
                },
                "include": ["src"],
            }
        )
    )
    for index in range(1800):
        (project / "src" / f"component_{index:04}.ts").write_text(
            f"export const component{index} = {index};\n"
        )


def validate_workloads(root: Path, image: str) -> None:
    if root.exists():
        raise ValueError("Use a fresh validation directory")
    prepare_workloads(root / "fixtures")
    repo = Path(__file__).resolve().parents[1]
    for name, case in WORKLOADS.items():
        trial = root / name
        workspace = trial / "workspace"
        shutil.copytree(root / "fixtures" / name / "project", workspace)
        docker = [
            "docker",
            "run",
            "--rm",
            "--workdir",
            "/workspace",
            "--mount",
            f"type=bind,src={workspace.resolve()},dst=/workspace",
            "--mount",
            f"type=bind,src={(root / 'fixtures' / name).resolve()},dst=/fixture,readonly",
            "--mount",
            f"type=bind,src={repo / 'node_modules'},dst=/opt/tools/node_modules,readonly",
            image,
            "bash",
            "-c",
        ]
        initial = subprocess.run(
            docker + [case.command],
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )
        (trial / "initial.txt").write_text(initial.stdout + initial.stderr)
        if initial.returncode != 0 or (
            case.verify and "Exit status: 1" not in initial.stdout
        ):
            raise RuntimeError(
                f"Unexpected baseline status: {name}: {initial.returncode}"
            )
        if case.verify:
            broken = subprocess.run(
                docker + [case.verify],
                capture_output=True,
                text=True,
                check=False,
                timeout=120,
            )
            if broken.returncode == 0:
                raise RuntimeError(f"Verifier accepted broken project: {name}")
            (workspace / case.editable).write_text(case.solution)
            repaired = subprocess.run(
                docker + [case.verify],
                capture_output=True,
                text=True,
                check=False,
                timeout=120,
            )
            (trial / "repaired.txt").write_text(repaired.stdout + repaired.stderr)
            if repaired.returncode:
                raise RuntimeError(f"Verifier rejected known repair: {name}")
        print(
            json.dumps(
                {
                    "workload": name,
                    "initial_exit": initial.returncode,
                    "initial_chars": len(initial.stdout + initial.stderr),
                    "oracle_checked": bool(case.verify),
                }
            ),
            flush=True,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("evidence", type=Path)
    parser.add_argument("--image", default="jev-retention:2.1.274")
    args = parser.parse_args()
    validate_workloads(args.evidence, args.image)
