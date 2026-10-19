from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from draw import render_run
from headline import README_TARGETS, readme_blocks
from page import page_blocks
from sources import CHARTS_DIRECTORY, REPO_ROOT, Run, latest_run

BENCHMARKS_PAGE = "BENCHMARKS.md"
REGENERATE_COMMAND = "uv run --frozen python generate.py"
REDRAW_COMMAND = "uv run --frozen python draw.py"


def inject(text: str, blocks: dict[str, str], page_name: str) -> str:
    for block_id, content in blocks.items():
        start = f"<!-- BENCH:{block_id} START -->"
        end = f"<!-- BENCH:{block_id} END -->"
        start_at = text.find(start)
        end_at = text.find(end)
        if start_at == -1 or end_at == -1 or end_at < start_at:
            raise SystemExit(f"benchmark writeup: the markers of '{block_id}' are missing or out of order in {page_name}")
        text = f"{text[: start_at + len(start)]}\n{content}\n{text[end_at:]}"
    return text


def generated_pages(root: Path, run: Run) -> dict[str, tuple[str, str]]:
    pages: dict[str, tuple[str, str]] = {}
    current = (root / BENCHMARKS_PAGE).read_text(encoding="utf-8")
    pages[BENCHMARKS_PAGE] = (current, inject(current, page_blocks(run), BENCHMARKS_PAGE))
    for target in README_TARGETS:
        current = (root / target.path).read_text(encoding="utf-8")
        pages[target.path] = (current, inject(current, readme_blocks(run, target), target.path))
    return pages


def stale_run_files(run: Run) -> list[str]:
    stale: list[str] = []
    with tempfile.TemporaryDirectory() as scratch:
        scratch_root = Path(scratch)
        drawn = render_run(run, scratch_root)
        expected = {path.relative_to(scratch_root) for path in drawn}
        for path in drawn:
            relative = path.relative_to(scratch_root)
            committed = run.directory / relative
            if not committed.is_file() or committed.read_bytes() != path.read_bytes():
                stale.append(relative.as_posix())
        charts = run.directory / CHARTS_DIRECTORY
        if charts.is_dir():
            for path in charts.iterdir():
                relative = path.relative_to(run.directory)
                if relative not in expected:
                    stale.append(f"{relative.as_posix()}, which no drawing of the run produces")
    return sorted(stale)


def check(run: Run, pages: dict[str, tuple[str, str]]) -> int:
    out_of_date = [name for name, (current, updated) in pages.items() if updated != current]
    if out_of_date:
        sys.stderr.write(
            f"{', '.join(out_of_date)} differ from run {run.run_id}. From benchmarks/writeup, run "
            f"`{REGENERATE_COMMAND}` and commit the result.\n"
        )
        return 1
    stale = stale_run_files(run)
    if stale:
        sys.stderr.write(
            f"{len(stale)} file(s) of run {run.run_id} differ from a fresh drawing, starting with {stale[0]}. "
            f"From benchmarks/writeup, run `{REDRAW_COMMAND}` and commit the result.\n"
        )
        return 1
    sys.stdout.write(f"Every page, the comparison, and every chart match run {run.run_id}.\n")
    return 0


def main(argv: list[str]) -> int:
    root = REPO_ROOT
    run = latest_run(root)
    pages = generated_pages(root, run)
    if "--check" in argv:
        return check(run, pages)
    changed = [name for name, (current, updated) in pages.items() if updated != current]
    for name in changed:
        (root / name).write_text(pages[name][1], encoding="utf-8")
    if changed:
        sys.stdout.write(f"Wrote {', '.join(changed)} from run {run.run_id}.\n")
    else:
        sys.stdout.write(f"Every page already matches run {run.run_id}.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
