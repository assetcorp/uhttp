from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
RUNS_DIRECTORY = "benchmarks/results/runs"
RESULTS_FILE = "results.json"
MACHINE_FILE = "machine.json"
COMPARISON_FILE = "comparison.md"
CHARTS_DIRECTORY = "charts"
SUPPORTED_SCHEMA = 1
_RUN_ID = re.compile(r"^\d{8}T\d{6}Z$")


@dataclass(frozen=True)
class Run:
    run_id: str
    directory: Path
    results: dict
    machine: dict


def _read_json(path: Path) -> dict:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise SystemExit(f"benchmark writeup: {path} is missing") from error
    except json.JSONDecodeError as error:
        raise SystemExit(f"benchmark writeup: {path} holds invalid JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise SystemExit(f"benchmark writeup: {path} must contain a JSON object")
    return parsed


def load_run(directory: Path) -> Run:
    if not _RUN_ID.match(directory.name):
        raise SystemExit(f"benchmark writeup: {directory} is not a run directory named by its UTC time")
    results = _read_json(directory / RESULTS_FILE)
    if results.get("schema") != SUPPORTED_SCHEMA:
        raise SystemExit(f"benchmark writeup: {directory / RESULTS_FILE} uses schema {results.get('schema')}")
    return Run(run_id=directory.name, directory=directory, results=results, machine=_read_json(directory / MACHINE_FILE))


def latest_run(root: Path = REPO_ROOT) -> Run:
    runs_root = root / RUNS_DIRECTORY
    names = [entry.name for entry in runs_root.iterdir() if entry.is_dir() and _RUN_ID.match(entry.name)] if runs_root.is_dir() else []
    if not names:
        raise SystemExit(
            f"benchmark writeup: {runs_root} holds no run; run the suite with `pnpm --dir benchmarks/suite bench` first"
        )
    return load_run(runs_root / max(names))


def repository_path(path: Path, root: Path = REPO_ROOT) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()
