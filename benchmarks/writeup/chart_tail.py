from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
from chart_paths import latency_chart
from chart_style import (
    BASE_FONT_POINTS,
    FIGURE_WIDTH_INCHES,
    caption,
    millisecond_label,
    save,
    server_colour,
    style_axes,
)
from data import PERCENTILES, VARIANT_TITLES, peak, route_title, routes_present, server_ids, server_name
from matplotlib.ticker import FuncFormatter
from render import is_number

LEGEND_RESERVE = 0.22
TITLE_ROW_RESERVE_POINTS = 70
FIGURE_HEIGHT_INCHES = 3.6
TAIL_LINE_WIDTH = 1.6
TAIL_MARKER_SIZE = 3.5
CONNECTIONS_LABEL_MARGIN = -0.6


def _profile(item: dict | None) -> list[tuple[int, float]]:
    latency = (item or {}).get("latency") or {}
    points = []
    for position, (field, _) in enumerate(PERCENTILES):
        value = latency.get(field)
        if is_number(value) and value > 0:
            points.append((position, float(value)))
    return points


def latency_figure(destination: Path, results: dict, run_id: str, variant: str) -> Path | None:
    routes = [route for route in routes_present(results) if any(_profile(peak(results, route, variant, server)) for server in server_ids(results))]
    if not routes:
        return None
    figure, grid = plt.subplots(
        1, len(routes), figsize=(FIGURE_WIDTH_INCHES, FIGURE_HEIGHT_INCHES), sharey=True, squeeze=False
    )
    for index, route in enumerate(routes):
        axes = grid[0][index]
        for server in server_ids(results):
            best = peak(results, route, variant, server)
            points = _profile(best)
            if best is None or not points:
                continue
            axes.plot(
                [position for position, _ in points],
                [value for _, value in points],
                color=server_colour(server),
                marker="o",
                markersize=TAIL_MARKER_SIZE,
                linewidth=TAIL_LINE_WIDTH,
                label=server_name(results, server),
            )
            first_position, first_value = points[0]
            axes.annotate(
                str(best.get("connections")),
                xy=(first_position, first_value),
                xytext=(-5, 0),
                textcoords="offset points",
                ha="right",
                va="center",
                fontsize=BASE_FONT_POINTS - 2,
                color=server_colour(server),
            )
        axes.set_xlim(left=CONNECTIONS_LABEL_MARGIN)
        style_axes(axes, "Latency (ms)" if index == 0 else "")
        axes.set_yscale("log")
        axes.yaxis.set_major_formatter(FuncFormatter(millisecond_label))
        axes.set_title(route_title(results, route), fontsize=BASE_FONT_POINTS)
        axes.set_xticks(list(range(len(PERCENTILES))))
        axes.set_xticklabels([label for _, label in PERCENTILES], fontsize=BASE_FONT_POINTS - 1)
    caption(
        figure,
        f"Latency at each server's peak {VARIANT_TITLES[variant]}",
        f"The number beside each line gives the connections at that server's peak · run {run_id}",
        TITLE_ROW_RESERVE_POINTS,
    )
    handles: list = []
    labels: list[str] = []
    for axes in grid[0]:
        for handle, label in zip(*axes.get_legend_handles_labels()):
            if label not in labels:
                handles.append(handle)
                labels.append(label)
    figure.legend(handles, labels, loc="lower center", ncols=len(labels), fontsize=BASE_FONT_POINTS - 1)
    figure.subplots_adjust(wspace=0.12, bottom=LEGEND_RESERVE)
    return save(figure, destination / latency_chart(variant))
