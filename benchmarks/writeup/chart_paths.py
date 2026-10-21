from __future__ import annotations

from sources import CHARTS_DIRECTORY, RUNS_DIRECTORY


def peak_chart(variant: str, pipelining: int | None) -> str:
    return f"{CHARTS_DIRECTORY}/peak-{variant}-pipelining-{pipelining}.svg"


def sweep_chart(route: str, variant: str, pipelining: int | None) -> str:
    return f"{CHARTS_DIRECTORY}/sweep-{route}-{variant}-pipelining-{pipelining}.svg"


def latency_chart(variant: str, pipelining: int | None) -> str:
    return f"{CHARTS_DIRECTORY}/latency-{variant}-pipelining-{pipelining}.svg"


def published(run_id: str, chart: str) -> str:
    return f"{RUNS_DIRECTORY}/{run_id}/{chart}"


def figure(path: str, alt: str) -> str:
    return f'<img src="{path}" alt="{alt}" width="820">'
