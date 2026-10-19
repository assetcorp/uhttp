from __future__ import annotations

from pathlib import Path

from run_details import machine_bullets, settings_sentences
from sources import COMPARISON_FILE, Run
from tables import table_sections

FAILURE_HEADING = "## Failed measurements"


def _failures(run: Run) -> str:
    failures = run.results.get("failures") or []
    if not failures:
        return ""
    lines = [FAILURE_HEADING, ""]
    for failure in failures:
        connections = failure.get("connections")
        where = f"at {connections} connections" if isinstance(connections, int) else "before any measurement"
        lines.append(
            f"- {failure.get('server')} on the {failure.get('route')} route with {failure.get('headers')} headers "
            f"failed {where}: {failure.get('error')}"
        )
    return "\n".join(lines)


def comparison_text(run: Run) -> str:
    created = run.results.get("created_at") or "an unrecorded time"
    parts = [
        f"# Benchmark run {run.run_id}",
        f"The suite recorded this run at {created}.",
        "## Machine",
        "\n".join(machine_bullets(run)),
        "## Load",
        settings_sentences(run),
        "## Results",
        table_sections(run.results, "###"),
        _failures(run),
    ]
    return "\n\n".join(part for part in parts if part) + "\n"


def write_comparison(run: Run, destination: Path) -> Path:
    path = destination / COMPARISON_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(comparison_text(run), encoding="utf-8")
    return path
