"""Prepare and run a frozen, capture-only sample from three benchmark families."""

import argparse
import ast
import hashlib
import json
import os
import shutil
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from urllib.request import urlopen

from evals.codex_bench import access_blocked, git
from evals.full import save
from evals.harbor_capture import INSTRUCTIONS
from evals.harbor_codex import MODEL, OVERRIDES, REPO, VERSION

SEED = "jev-three-family-capture-v1"
DAB_REV = "c8fb51b3b898e1755f3b5a00c8dc5f25a52ff678"
DAB_SCORER_REV = "d4431c2e4a695cbe43c33aab2adaa304a37ae64a"
DAB_FILES = [
    "acquirer_countries.csv",
    "fees.json",
    "manual.md",
    "merchant_category_codes.csv",
    "merchant_data.json",
    "payments-readme.md",
    "payments.csv",
]
COMPILE_STRATA = [
    ["cowsay"],
    ["coreutils", "coreutils-old-version", "coreutils-old-version-alpine"],
    ["jq", "jq-static", "jq-static-musl"],
    ["jq-windows", "jq-windows2"],
    ["curl", "curl-ssl", "curl-ssl-arm64-static", "curl-ssl-arm64-static2"],
]
DOCKERFILE = """FROM python:3.12.9-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \\
    bash curl git poppler-utils tesseract-ocr && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir pandas==2.2.3 PyMuPDF==1.25.5
WORKDIR /workdir
COPY input/ /workdir/input/
"""
TASK_CONFIG = """version = "1.0"
[metadata]
category = "data-analysis"
[agent]
timeout_sec = 900.0
[verifier]
timeout_sec = 60.0
[environment]
build_timeout_sec = 900.0
cpus = 2
memory_mb = 4096
storage_mb = 10240
"""


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def rank(value: str) -> str:
    return hashlib.sha256(f"{SEED}:{value}".encode()).hexdigest()


def download(url: str, path: Path) -> None:
    if path.exists():
        raise ValueError(f"Refusing to replace downloaded source: {path}")
    with urlopen(url, timeout=180) as response, path.open("wb") as output:
        shutil.copyfileobj(response, output)


def prepare(root: Path, compile_repo: Path, pdf_repo: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    if (root / "selection.json").exists():
        raise ValueError("Selection already exists")
    for source in (compile_repo, pdf_repo):
        if git(source, "status", "--porcelain"):
            raise ValueError("Dataset checkout must be unmodified")
    samples = json.loads((pdf_repo / "data/samples.json").read_text())
    selected_pdf = []
    used_docs: set[str] = set()
    for stratum in ("text", "table", "visual", "cross-page", "unanswerable"):
        candidates = []
        for index, sample in enumerate(samples):
            sources = ast.literal_eval(sample["evidence_sources"])
            pages = ast.literal_eval(sample["evidence_pages"])
            answerable = sample["answer"] != "Not answerable"
            matches = {
                "text": answerable and sources == ["Pure-text (Plain-text)"],
                "table": answerable and sources == ["Table"],
                "visual": answerable and sources in (["Chart"], ["Figure"]),
                "cross-page": answerable and len(pages) > 1,
                "unanswerable": not answerable,
            }
            if matches[stratum] and sample["doc_id"] not in used_docs:
                candidates.append((index, sample))
        index, sample = min(
            candidates,
            key=lambda pair: rank(pair[1]["doc_id"] + ":" + pair[1]["question"]),
        )
        used_docs.add(sample["doc_id"])
        selected_pdf.append({**sample, "source_index": index, "stratum": stratum})
    dev_source = root / "dab-dev.jsonl"
    if not dev_source.exists():
        download(
            f"https://huggingface.co/datasets/adyen/DABstep/resolve/{DAB_REV}/data/tasks/dev.jsonl",
            dev_source,
        )
    dab_samples = [
        json.loads(line) for line in (root / "dab-dev.jsonl").read_text().splitlines()
    ]
    selected_dab = []
    for level, count in (("easy", 2), ("hard", 3)):
        selected_dab.extend(
            sorted(
                [sample for sample in dab_samples if sample["level"] == level],
                key=lambda sample: rank("dab:" + sample["task_id"]),
            )[:count]
        )
    selected_compile = [min(group, key=rank) for group in COMPILE_STRATA]
    selection = {
        "seed": SEED,
        "compile_revision": git(compile_repo, "rev-parse", "HEAD"),
        "pdf_revision": git(pdf_repo, "rev-parse", "HEAD"),
        "dab_revision": DAB_REV,
        "dab_scorer_revision": DAB_SCORER_REV,
        "pdf_question_count": len(samples),
        "dab_pool": "public dev split; 10 questions with reference answers",
        "compile_strata": COMPILE_STRATA,
        "compile": selected_compile,
        "pdf": selected_pdf,
        "dab": selected_dab,
        "selection": "lowest SHA256(seed:value) per declared stratum; unique PDFs",
        "grading": "CompileBench original verifier; DAB official scorer; PDF official GPT-4o extraction and type-aware scorer, all outside agent environments",
    }
    save(root / "selection.json", selection)
    sources = root / "sources"
    sources.mkdir()
    for name in ("eval_score.py", "prompt_for_answer_extraction.md"):
        shutil.copyfile(pdf_repo / "eval" / name, sources / name)
    context = sources / "dab-context"
    context.mkdir()
    for name in DAB_FILES:
        download(
            f"https://huggingface.co/datasets/adyen/DABstep/resolve/{DAB_REV}/data/context/{name}",
            context / name,
        )
    download(
        f"https://huggingface.co/spaces/adyen/DABstep/resolve/{DAB_SCORER_REV}/dabstep_benchmark/evaluation/scorer.py",
        sources / "dab_scorer.py",
    )
    tasks = root / "tasks"
    tasks.mkdir()
    rows = []
    for name in selected_compile:
        task = f"compile-{name}"
        shutil.copytree(compile_repo / "datasets/compilebench" / name, tasks / task)
        rows.append({"task": task, "family": "compile", "source_id": name})
    for family, samples_to_use in (("pdf", selected_pdf), ("dab", selected_dab)):
        for sample in samples_to_use:
            source_id = (
                str(sample["source_index"]) if family == "pdf" else sample["task_id"]
            )
            task = f"{family}-{source_id}"
            folder = tasks / task
            environment = folder / "environment"
            environment.mkdir(parents=True)
            (folder / "task.toml").write_text(TASK_CONFIG)
            (environment / "Dockerfile").write_text(DOCKERFILE)
            if family == "pdf":
                (environment / "input").mkdir()
                shutil.copyfile(
                    pdf_repo / "data/documents" / sample["doc_id"],
                    environment / "input/document.pdf",
                )
                prompt = (
                    "Answer the following question using /workdir/input/document.pdf.\n"
                    "You have access to the complete PDF, pdftotext, pdftoppm, "
                    "Python PyMuPDF, and image viewing. Use any pages or visual "
                    "evidence needed. Do not rely on external sources.\n\n"
                    + sample["question"]
                    + "\n\nGive your answer in your final response. If the document "
                    "does not support an answer, say Not answerable."
                )
            else:
                shutil.copytree(context, environment / "input")
                prompt = (
                    "Analyze the supplied data and documentation in /workdir/input. "
                    "Python with pandas is available. Use these files as your evidence.\n\n"
                    + sample["question"]
                    + "\n\n"
                    + sample["guidelines"]
                )
            (folder / "instruction.md").write_text(prompt + "\n")
            rows.append({"task": task, "family": family, "source_id": source_id})
    save(root / "rows.json", rows)


def task_hashes(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): digest(path)
        for path in sorted((root / "tasks").rglob("*"))
        if path.is_file()
    }


def freeze(root: Path, concurrency: int) -> None:
    if (root / "protocol.json").exists() or git(REPO, "status", "--porcelain"):
        raise ValueError("Commit sources and use an unfrozen run")
    rows = json.loads((root / "rows.json").read_text())
    if len(rows) != 15:
        raise ValueError("Expected exactly 15 planned attempts")
    save(
        root / "protocol.json",
        {
            "created_at": datetime.now(UTC).isoformat(),
            "commit": git(REPO, "rev-parse", "HEAD"),
            "selection_sha256": digest(root / "selection.json"),
            "rows_sha256": digest(root / "rows.json"),
            "task_sha256": task_hashes(root),
            "scorer_sha256": {
                path.name: digest(path)
                for path in (root / "sources").iterdir()
                if path.is_file()
            },
            "instructions": INSTRUCTIONS,
            "model": MODEL,
            "version": VERSION,
            "harbor": "0.22.0",
            "reasoning_effort": "high",
            "tool_output_token_limit": 10000,
            "pruning_enabled": False,
            "concurrency": concurrency,
            "repetitions": 1,
            "retries": 0,
            "environment": "modal",
            "modal_image_builder_version": "2025.06",
            "rates_per_million": {"input": 5, "output": 30, "jev_input": 0.042},
            "scope": "capture-only adapted pilot, not full benchmark scores or a savings comparison",
        },
    )
    save(
        root / "progress.json",
        [{**row, "state": "pending"} for row in rows],
    )


def run(root: Path, harbor: str) -> None:
    protocol = json.loads((root / "protocol.json").read_text())
    rows = json.loads((root / "progress.json").read_text())
    if (
        any(row["state"] != "pending" for row in rows)
        or git(REPO, "status", "--porcelain")
        or git(REPO, "rev-parse", "HEAD") != protocol["commit"]
        or task_hashes(root) != protocol["task_sha256"]
        or digest(root / "selection.json") != protocol["selection_sha256"]
        or digest(root / "rows.json") != protocol["rows_sha256"]
    ):
        raise ValueError("A started or changed protocol cannot be run")
    if subprocess.check_output([harbor, "--version"], text=True).strip() != "0.22.0":
        raise ValueError("Harbor 0.22.0 required")
    auth = json.loads(Path(os.environ["JEV_CODEX_AUTH_FILE"]).read_text())
    if auth.get("auth_mode") != "chatgpt" or auth.get("OPENAI_API_KEY"):
        raise ValueError("Existing ChatGPT login required; no API fallback")
    (root / "console").mkdir()
    (root / "jobs").mkdir()
    lock, stop = threading.Lock(), threading.Event()

    def attempt(row: dict[str, str]) -> None:
        with lock:
            if stop.is_set():
                row["state"] = "blocked"
                save(root / "progress.json", rows)
                return
            row["state"] = "running"
            row["started_at"] = datetime.now(UTC).isoformat()
            save(root / "progress.json", rows)
        env = {
            key: value
            for key, value in os.environ.items()
            if key not in (*OVERRIDES, "TYPESAFE_API_KEY")
        }
        env.update(
            PYTHONPATH=str(REPO),
            JEV_EVAL_ARM="control",
            MODAL_IMAGE_BUILDER_VERSION="2025.06",
        )
        command = [
            harbor,
            "run",
            "-p",
            str(root / "tasks" / row["task"]),
            "-a",
            "evals.harbor_capture:CaptureCodex",
            "-m",
            MODEL,
            "--ak",
            f"version={VERSION}",
            "--ak",
            "reasoning_effort=high",
            "-n",
            "1",
            "-k",
            "1",
            "-r",
            "0",
            "--env",
            "modal",
            "--ek",
            "app_name=jev-terminal-bench",
            "--job-name",
            row["task"],
            "--jobs-dir",
            str(root / "jobs"),
        ]
        if row["family"] != "compile":
            command.append("--disable-verification")
        try:
            with (root / "console" / f"{row['task']}.log").open("w") as output:
                result = subprocess.run(
                    command, cwd=REPO, env=env, stdout=output, stderr=subprocess.STDOUT
                )
            row["returncode"] = str(result.returncode)
            row["state"] = "finished"
            if access_blocked(root / "jobs" / row["task"]):
                row["blocker"] = "Codex account or authentication error"
                stop.set()
        except OSError as error:
            row["state"], row["error"] = "launcher_error", str(error)
            stop.set()
        finally:
            with lock:
                row["finished_at"] = datetime.now(UTC).isoformat()
                save(root / "progress.json", rows)
                print(f"{row['task']}: {row['state']}", flush=True)

    with ThreadPoolExecutor(max_workers=protocol["concurrency"]) as pool:
        list(pool.map(attempt, rows))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["prepare", "freeze", "run"])
    parser.add_argument("root", type=Path)
    parser.add_argument("--compile-repo", type=Path)
    parser.add_argument("--pdf-repo", type=Path)
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--harbor", default="harbor")
    args = parser.parse_args()
    root = args.root.resolve()
    if root.is_relative_to(REPO) or not 1 <= args.concurrency <= 16:
        parser.error("Use external evidence and 1–16 workers")
    if args.action == "prepare":
        if not args.compile_repo or not args.pdf_repo:
            parser.error("Both source checkouts are required")
        prepare(root, args.compile_repo, args.pdf_repo)
    elif args.action == "freeze":
        freeze(root, args.concurrency)
    else:
        run(root, args.harbor)


if __name__ == "__main__":
    main()
