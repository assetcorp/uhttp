from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
from chart_paths import sweep_chart
from chart_style import (
    BASE_FONT_POINTS,
    FIGURE_WIDTH_INCHES,
    LINE_WIDTH,
    MARKER_SIZE,
    caption,
    connections_axis,
    latency_axis,
    rate_label,
    save,
    server_colour,
    style_axes,
)
from data import VARIANT_TITLES, connection_levels, route_title, rows, server_ids, server_name
from matplotlib.ticker import FuncFormatter
from render import is_number

LEGEND_COLUMNS = 5
LEGEND_ANCHOR_BELOW_AXES = (0.5, -0.4)
PANEL_HEIGHT_INCHES = 2.4
PANEL_RATIOS = (1.1, 1.1, 0.8)
CAPTION_HEIGHT_INCHES = 0.6
PANEL_GAP_FRACTION = 0.16


def _series(found: list[dict], pick) -> tuple[list[int], list[float]]:
    xs: list[int] = []
    ys: list[float] = []
    for item in found:
        value = pick(item)
        connections = item.get("connections")
        if isinstance(connections, int) and is_number(value) and value > 0:
            xs.append(connections)
            ys.append(float(value))
    return xs, ys


def _rate(item: dict) -> object:
    return item.get("requests_per_second")


def _p99(item: dict) -> object:
    return (item.get("latency") or {}).get("p99_ms")


def _cores(item: dict) -> object:
    return item.get("cpu_cores_busy")


def sweep_figure(destination: Path, results: dict, run_id: str, route: str, variant: str) -> Path | None:
    levels = connection_levels(results)
    servers = [server for server in server_ids(results) if rows(results, route, variant, server)]
    if len(levels) < 2 or not servers:
        return None
    figure, grid = plt.subplots(
        len(PANEL_RATIOS),
        1,
        figsize=(FIGURE_WIDTH_INCHES, PANEL_HEIGHT_INCHES * len(PANEL_RATIOS) + CAPTION_HEIGHT_INCHES),
        sharex=True,
        height_ratios=PANEL_RATIOS,
        squeeze=False,
    )
    throughput, latency, cores = (axes for (axes,) in grid)
    for server in servers:
        found = rows(results, route, variant, server)
        style = {
            "color": server_colour(server),
            "marker": "o",
            "markersize": MARKER_SIZE,
            "linewidth": LINE_WIDTH,
            "label": server_name(results, server),
        }
        throughput.plot(*_series(found, _rate), **style)
        latency.plot(*_series(found, _p99), **style)
        cores.plot(*_series(found, _cores), **style)
    style_axes(throughput, "Requests a second")
    throughput.yaxis.set_major_formatter(FuncFormatter(rate_label))
    throughput.set_ylim(bottom=0)
    style_axes(latency, "p99 latency (ms)")
    latency_axis(latency)
    style_axes(cores, "Server CPU cores busy")
    cores.set_ylim(bottom=0)
    connections_axis(cores, levels)
    cores.set_xlabel("Connections")
    cores.legend(loc="upper center", bbox_to_anchor=LEGEND_ANCHOR_BELOW_AXES, ncols=LEGEND_COLUMNS, fontsize=BASE_FONT_POINTS - 1)
    pipelined = (results.get("settings") or {}).get("pipelined_requests")
    caption(
        figure,
        f"{route_title(results, route)} route {VARIANT_TITLES[variant]}, across connections",
        f"{pipelined} pipelined requests per connection · run {run_id}",
    )
    figure.subplots_adjust(hspace=PANEL_GAP_FRACTION)
    return save(figure, destination / sweep_chart(route, variant))
