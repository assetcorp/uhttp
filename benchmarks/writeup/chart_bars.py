from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
from chart_paths import peak_chart
from chart_style import (
    BASE_FONT_POINTS,
    FIGURE_WIDTH_INCHES,
    POINTS_PER_INCH,
    caption,
    rate_label,
    save,
    server_colour,
    style_axes,
)
from data import VARIANT_TITLES, peak, rate, route_title, routes_present, server_ids, server_name
from matplotlib.ticker import FuncFormatter, MaxNLocator

BAR_HEIGHT = 0.62
ROW_HEIGHT_INCHES = 0.3
PANEL_MARGIN_INCHES = 0.55
PANEL_SPACING = 0.55
TITLE_RESERVE_POINTS = 62
VALUE_LABEL_GAP = 0.01
X_HEADROOM = 1.18


def _entries(results: dict, route: str, variant: str) -> list[tuple[str, float, int]]:
    entries = []
    for server in server_ids(results):
        best = peak(results, route, variant, server)
        value = rate(best)
        if best is not None and value is not None:
            entries.append((server, value, best.get("connections") or 0))
    return sorted(entries, key=lambda entry: entry[1], reverse=True)


def _panel(axes, results: dict, route: str, entries: list[tuple[str, float, int]]) -> None:
    positions = list(range(len(entries)))
    values = [value for _, value, _ in entries]
    axes.barh(positions, values, height=BAR_HEIGHT, color=[server_colour(server) for server, _, _ in entries])
    style_axes(axes, "")
    axes.set_yticks(positions)
    axes.set_yticklabels([server_name(results, server) for server, _, _ in entries], fontsize=BASE_FONT_POINTS)
    axes.invert_yaxis()
    top = max(values) * X_HEADROOM
    axes.set_xlim(0, top)
    axes.xaxis.set_major_locator(MaxNLocator(nbins=4))
    axes.xaxis.set_major_formatter(FuncFormatter(rate_label))
    axes.grid(True, axis="y", alpha=0)
    axes.set_title(route_title(results, route), fontsize=BASE_FONT_POINTS + 1, loc="left")
    for position, (_, value, connections) in enumerate(entries):
        axes.text(
            value + top * VALUE_LABEL_GAP,
            position,
            f"{rate_label(round(value, -3))} at {connections} connections",
            va="center",
            fontsize=BASE_FONT_POINTS - 1.5,
        )


def peak_figure(destination: Path, results: dict, run_id: str, variant: str) -> Path | None:
    panels = [(route, _entries(results, route, variant)) for route in routes_present(results)]
    panels = [(route, entries) for route, entries in panels if entries]
    if not panels:
        return None
    bar_rows = sum(len(entries) for _, entries in panels)
    height_inches = (
        TITLE_RESERVE_POINTS / POINTS_PER_INCH + ROW_HEIGHT_INCHES * bar_rows + PANEL_MARGIN_INCHES * len(panels)
    )
    figure, grid = plt.subplots(
        len(panels),
        1,
        figsize=(FIGURE_WIDTH_INCHES, height_inches),
        height_ratios=[len(entries) for _, entries in panels],
        squeeze=False,
    )
    for (axes,), (route, entries) in zip(grid, panels):
        _panel(axes, results, route, entries)
    grid[-1][0].set_xlabel("Peak requests a second")
    pipelined = (results.get("settings") or {}).get("pipelined_requests")
    caption(
        figure,
        f"Peak throughput {VARIANT_TITLES[variant]}",
        f"{pipelined} pipelined requests per connection · run {run_id}",
        TITLE_RESERVE_POINTS,
    )
    figure.subplots_adjust(hspace=PANEL_SPACING)
    return save(figure, destination / peak_chart(variant))
