from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
from matplotlib.figure import Figure
from matplotlib.ticker import FuncFormatter, LogLocator

UHTTP_VIOLET = "#7c3aed"
REFERENCE_SLATE = "#64748b"
CHART_AMBER = "#eda100"
CHART_GREEN = "#15803d"
CHART_PINK = "#db2777"
BACKGROUND_COLOUR = "#ffffff"
TEXT_COLOUR = "#334155"
GRID_COLOUR = "#e2e8f0"

SERVER_COLOURS = {
    "uhttp": UHTTP_VIOLET,
    "uws": REFERENCE_SLATE,
    "hono": CHART_AMBER,
    "fastify": CHART_GREEN,
    "express": CHART_PINK,
}

FIGURE_WIDTH_INCHES = 8.2
BASE_FONT_POINTS = 9
CAPTION_RESERVE_POINTS = 46
LATENCY_MINOR_SUBDIVISIONS = (2.0, 5.0)
LINE_WIDTH = 1.8
MARKER_SIZE = 4
POINTS_PER_INCH = 72
CAPTION_LEFT_FRACTION = 0.008
TITLE_TOP_OFFSET_POINTS = 12
SUBTITLE_TOP_OFFSET_POINTS = 28

_RC = {
    "figure.dpi": 100,
    "savefig.dpi": 100,
    "font.size": BASE_FONT_POINTS,
    "font.family": "sans-serif",
    "font.sans-serif": ["DejaVu Sans"],
    "text.color": TEXT_COLOUR,
    "axes.labelcolor": TEXT_COLOUR,
    "axes.edgecolor": GRID_COLOUR,
    "axes.titlesize": BASE_FONT_POINTS + 1,
    "axes.titleweight": "bold",
    "axes.facecolor": BACKGROUND_COLOUR,
    "figure.facecolor": BACKGROUND_COLOUR,
    "savefig.facecolor": BACKGROUND_COLOUR,
    "xtick.color": TEXT_COLOUR,
    "ytick.color": TEXT_COLOUR,
    "grid.color": GRID_COLOUR,
    "grid.linewidth": 0.6,
    "legend.frameon": False,
    "svg.fonttype": "path",
    "svg.hashsalt": "uhttp-benchmarks",
    "path.simplify": False,
}


def apply_style() -> None:
    plt.rcParams.update(_RC)


def server_colour(server: str) -> str:
    return SERVER_COLOURS.get(server, REFERENCE_SLATE)


def rate_label(value: float, _position: float = 0) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:g}M"
    if value >= 1_000:
        return f"{value / 1_000:g}K"
    return f"{value:g}"


def millisecond_label(value: float, _position: float = 0) -> str:
    return f"{value:,.0f}" if value >= 1_000 else f"{value:g}"


def style_axes(axes, ylabel: str) -> None:
    axes.set_ylabel(ylabel)
    axes.grid(True, which="major", axis="both", alpha=0.7)
    axes.set_axisbelow(True)
    for side in ("top", "right"):
        axes.spines[side].set_visible(False)


def connections_axis(axes, ticks: Sequence[int]) -> None:
    axes.set_xscale("log")
    axes.set_xticks(list(ticks))
    axes.xaxis.set_major_formatter(FuncFormatter(lambda value, _position=0: f"{value:g}"))
    axes.minorticks_off()


def latency_axis(axes) -> None:
    axes.set_yscale("log")
    axes.yaxis.set_major_formatter(FuncFormatter(millisecond_label))
    axes.yaxis.set_minor_locator(LogLocator(base=10, subs=LATENCY_MINOR_SUBDIVISIONS))
    axes.yaxis.set_minor_formatter(FuncFormatter(millisecond_label))


def caption(figure: Figure, title: str, subtitle: str, reserve_points: float = CAPTION_RESERVE_POINTS) -> None:
    height_points = figure.get_size_inches()[1] * POINTS_PER_INCH
    figure.text(
        CAPTION_LEFT_FRACTION,
        1 - TITLE_TOP_OFFSET_POINTS / height_points,
        title,
        ha="left",
        va="top",
        fontsize=BASE_FONT_POINTS + 3,
        fontweight="bold",
    )
    figure.text(
        CAPTION_LEFT_FRACTION,
        1 - SUBTITLE_TOP_OFFSET_POINTS / height_points,
        subtitle,
        ha="left",
        va="top",
        fontsize=BASE_FONT_POINTS - 1,
        color=REFERENCE_SLATE,
    )
    figure.subplots_adjust(top=1 - reserve_points / height_points)


def save(figure: Figure, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(destination, format="svg", bbox_inches="tight", pad_inches=0.12, metadata={"Date": None})
    plt.close(figure)
    return destination
