from __future__ import annotations

import sys
from pathlib import Path

from chart_bars import peak_figure
from chart_style import apply_style
from chart_sweep import sweep_figure
from chart_tail import latency_figure
from comparison import write_comparison
from data import routes_present, variants_present
from sources import Run, latest_run, load_run


def render_run(run: Run, destination: Path) -> list[Path]:
    apply_style()
    results = run.results
    drawn: list[Path | None] = [write_comparison(run, destination)]
    for variant in variants_present(results):
        drawn.append(peak_figure(destination, results, run.run_id, variant))
        for route in routes_present(results):
            drawn.append(sweep_figure(destination, results, run.run_id, route, variant))
        drawn.append(latency_figure(destination, results, run.run_id, variant))
    return [path for path in drawn if path is not None]


def main(argv: list[str]) -> int:
    run = load_run(Path(argv[0]).resolve()) if argv else latest_run()
    written = render_run(run, run.directory)
    sys.stdout.write(f"Wrote the comparison and {len(written) - 1} charts into {run.directory}.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
