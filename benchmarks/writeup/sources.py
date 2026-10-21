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
SUPPORTED_SCHEMAS = (1, 2)
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
        raise SystemExit(f"benchmark writeup: the generator cannot parse {path} as JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise SystemExit(f"benchmark writeup: {path} must contain a JSON object")
    return parsed


def _with_one_pipelining_level(results: dict) -> dict:
    settings = results.get("settings") or {}
    level = settings.get("pipelined_requests")
    return {
        **results,
        "settings": {**settings, "pipelining_levels": [level]},
        "measurements": [{**item, "pipelined_requests": level} for item in results.get("measurements") or []],
        "failures": [{**item, "pipelined_requests": level} for item in results.get("failures") or []],
    }


def load_run(directory: Path) -> Run:
    if not _RUN_ID.match(directory.name):
        raise SystemExit(f"benchmark writeup: name the run directory {directory} by its UTC time, such as 20261019T004707Z")
    results = _read_json(directory / RESULTS_FILE)
    if results.get("schema") not in SUPPORTED_SCHEMAS:
        raise SystemExit(
            f"benchmark writeup: {directory / RESULTS_FILE} has schema {results.get('schema')}, "
            f"and the generator reads schemas {' and '.join(str(schema) for schema in SUPPORTED_SCHEMAS)} alone"
        )
    if results.get("schema") == 1:
        results = _with_one_pipelining_level(results)
    return Run(run_id=directory.name, directory=directory, results=results, machine=_read_json(directory / MACHINE_FILE))


def latest_run(root: Path = REPO_ROOT) -> Run:
    runs_root = root / RUNS_DIRECTORY
    names = [entry.name for entry in runs_root.iterdir() if entry.is_dir() and _RUN_ID.match(entry.name)] if runs_root.is_dir() else []
    if not names:
        raise SystemExit(
            f"benchmark writeup: the suite has written no run into {runs_root} yet, "
            "so start it with `pnpm --dir benchmarks/suite bench` first"
        )
    return load_run(runs_root / max(names))


def repository_path(path: Path, root: Path = REPO_ROOT) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()
