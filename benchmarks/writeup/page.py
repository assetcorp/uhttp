from __future__ import annotations

from chart_paths import figure, latency_chart, peak_chart, published, sweep_chart
from data import VARIANT_TITLES, created_date, route_title, routes_present, variants_present
from run_details import machine_bullets, settings_sentences
from sources import COMPARISON_FILE, RUNS_DIRECTORY, Run
from tables import table_sections


def run_block(run: Run) -> str:
    link = f"{RUNS_DIRECTORY}/{run.run_id}/{COMPARISON_FILE}"
    return (
        f"The suite recorded every figure on this page on {created_date(run.results)}, in run [`{run.run_id}`]({link}). "
        "You can find the hardware and the software of that run under [The machine](#the-machine)."
    )


def peak_block(run: Run) -> str:
    figures = [
        figure(published(run.run_id, peak_chart(variant)), f"Peak requests a second of each server {VARIANT_TITLES[variant]}")
        for variant in variants_present(run.results)
    ]
    return "\n\n".join(figures)


def sweep_block(run: Run) -> str:
    sections = []
    for route in routes_present(run.results):
        title = route_title(run.results, route)
        figures = [
            figure(
                published(run.run_id, sweep_chart(route, variant)),
                f"Requests a second, p99 latency, and CPU use on the {title} route {VARIANT_TITLES[variant]}",
            )
            for variant in variants_present(run.results)
        ]
        sections.append("\n\n".join([f"### {title} route", *figures]))
    return "\n\n".join(sections)


def latency_block(run: Run) -> str:
    figures = [
        figure(published(run.run_id, latency_chart(variant)), f"Latency percentiles at each server's peak {VARIANT_TITLES[variant]}")
        for variant in variants_present(run.results)
    ]
    return "\n\n".join(figures)


def page_blocks(run: Run) -> dict[str, str]:
    return {
        "run": run_block(run),
        "peak": peak_block(run),
        "tables": table_sections(run.results, "###"),
        "sweep": sweep_block(run),
        "latency": latency_block(run),
        "settings": settings_sentences(run),
        "machine": "\n".join(machine_bullets(run)),
    }
