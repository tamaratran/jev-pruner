"""Live paired transport checks, separate from benchmark attempts and grading."""

import argparse
import asyncio
import json
import os
from pathlib import Path

from harbor.environments.factory import EnvironmentFactory
from harbor.models.agent.context import AgentContext
from harbor.models.environment_type import EnvironmentType
from harbor.models.task.task import Task
from harbor.models.trial.paths import TrialPaths

from evals.full import save
from evals.harbor_codex import MODEL, VERSION
from evals.standardized_codex import StandardizedCodex

INSTRUCTION = (
    "This is a transport compatibility check, not the benchmark task. "
    "Run exactly this command once: "
    "node /opt/jev-eval/evals/codex_command.mjs -- printf 'preflight-ready\\n'\n"
    "Then reply READY. Do not build software or modify any files."
)
LARGE_INSTRUCTION = (
    "This is a transport compatibility check, not the benchmark task. "
    "Run exactly this command once: "
    "node /opt/jev-eval/evals/codex_command.mjs -- node -e "
    "\"process.stdout.write('preflight-ready\\n'.repeat(65536))\"\n"
    "Then reply READY. Do not build software or modify any files."
)


async def check(
    task_path: Path,
    root: Path,
    environment_type: EnvironmentType,
    compose: list[Path],
    large_output: bool = False,
) -> None:
    task = Task(task_path)
    root.mkdir(mode=0o700)
    results = []
    reference = None
    os.environ["MODAL_IMAGE_BUILDER_VERSION"] = "2025.06"
    os.environ.pop("JEV_EVAL_EXPECTED_START", None)
    for arm in ("control", "plugin"):
        os.environ["JEV_EVAL_ARM"] = arm
        if reference is not None:
            os.environ["JEV_EVAL_EXPECTED_START"] = str(reference)
        paths = TrialPaths(root / arm)
        paths.agent_dir.mkdir(parents=True)
        environment = EnvironmentFactory.create_environment(
            type=environment_type,
            environment_dir=task.paths.environment_dir,
            environment_name=task.name,
            session_id=f"standardized-{root.name}-{arm}",
            trial_paths=paths,
            task_env_config=task.config.environment,
            extra_docker_compose=compose,
            **(
                {"app_name": "jev-terminal-bench"}
                if environment_type == EnvironmentType.MODAL
                else {}
            ),
        )
        try:
            await environment.start(force_build=False)
            agent = StandardizedCodex(
                logs_dir=paths.agent_dir,
                model_name=MODEL,
                version=VERSION,
                reasoning_effort="high",
            )
            await agent.setup(environment)
            try:
                await agent.run(
                    LARGE_INSTRUCTION if large_output else INSTRUCTION,
                    environment,
                    AgentContext(),
                )
            finally:
                await environment.download_dir("/logs/agent", paths.agent_dir)
            start_path = paths.agent_dir / "start.json"
            start = json.loads(start_path.read_text())
            events = [
                json.loads(line)
                for line in (paths.agent_dir / "codex.txt").read_text().splitlines()
                if line.startswith("{")
            ]
            completed = [
                event for event in events if event.get("type") == "turn.completed"
            ]
            if start["status"] != "accepted" or len(completed) != 1:
                raise ValueError("Preflight rejected or inference incomplete")
            captures = list((paths.agent_dir / "observer").glob("*.raw"))
            expected_output = b"preflight-ready\n" * (65536 if large_output else 1)
            if len(captures) != 1 or captures[0].read_bytes() != expected_output:
                raise ValueError("Expected one captured wrapper command")
            if (
                not large_output
                and captures[0].with_suffix(".delivered").read_bytes()
                != captures[0].read_bytes()
            ):
                raise ValueError("Tiny probe output must be delivered unchanged")
            if reference is not None:
                expected = json.loads(reference.read_text())
                if start["sha256"] != expected["sha256"]:
                    raise ValueError("Paired starting fingerprints differ")
            results.append(
                {
                    "arm": arm,
                    "start_sha256": start["sha256"],
                    "usage": completed[0]["usage"],
                    "probe_bytes": len(expected_output),
                }
            )
            save(root / "results.json", results)
            print(f"{task.name} {arm}: accepted and completed", flush=True)
            reference = start_path
        except Exception as error:
            save(
                root / "gate.json",
                {"passed": False, "arm": arm, "error_type": type(error).__name__},
            )
            raise
        finally:
            await environment.stop(delete=True)
    save(
        root / "gate.json",
        {"passed": True, "scope": "Live compatibility only; no benchmark grading."},
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("task", type=Path)
    parser.add_argument("root", type=Path)
    parser.add_argument("--env", type=EnvironmentType, default=EnvironmentType.MODAL)
    parser.add_argument("--large-output", action="store_true")
    parser.add_argument(
        "--extra-docker-compose", type=Path, action="append", default=[]
    )
    args = parser.parse_args()
    if args.root.resolve().is_relative_to(Path(__file__).resolve().parents[1]):
        parser.error("Use an evidence directory outside the repository")
    asyncio.run(
        check(
            args.task.resolve(),
            args.root.resolve(),
            args.env,
            args.extra_docker_compose,
            args.large_output,
        )
    )


if __name__ == "__main__":
    main()
