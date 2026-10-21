from __future__ import annotations

from data import (
    REFERENCE_SERVER,
    VARIANT_TITLES,
    at_connections,
    headline_connections,
    load_title,
    peak,
    pipelining_levels,
    pipelining_view,
    rate,
    route_title,
    routes_present,
    server_ids,
    server_name,
    variants_present,
)
from render import decimal, integer, milliseconds, percent, table

HEADERS = (
    "Server",
    "Requests a second",
    "Share of the uWebSockets.js rate",
    "p50 (ms)",
    "p99 (ms)",
    "Server CPU cores",
    "Peak requests a second",
)
ALIGNS = ("left", "right", "right", "right", "right", "right", "right")


def _row(results: dict, route: str, variant: str, server: str, connections: int, reference: float | None) -> list[str]:
    item = at_connections(results, route, variant, server, connections)
    value = rate(item)
    latency = (item or {}).get("latency") or {}
    best = peak(results, route, variant, server)
    best_rate = rate(best)
    peak_text = "n/a" if best is None or best_rate is None else f"{integer(best_rate)} at {integer(best.get('connections'))}"
    share = percent(value / reference) if value is not None and reference else "n/a"
    return [
        server_name(results, server),
        integer(value),
        share,
        milliseconds(latency.get("p50_ms")),
        milliseconds(latency.get("p99_ms")),
        decimal((item or {}).get("cpu_cores_busy"), 2),
        peak_text,
    ]


def route_table(results: dict, route: str, variant: str) -> str | None:
    connections = headline_connections(results)
    if connections is None:
        return None
    servers = [server for server in server_ids(results) if peak(results, route, variant, server) is not None]
    if not servers:
        return None
    servers.sort(key=lambda server: rate(at_connections(results, route, variant, server, connections)) or 0.0, reverse=True)
    reference = rate(at_connections(results, route, variant, REFERENCE_SERVER, connections))
    return table(HEADERS, ALIGNS, [_row(results, route, variant, server, connections, reference) for server in servers])


def _load_sections(results: dict, heading: str) -> list[str]:
    sections = []
    for variant in variants_present(results):
        for route in routes_present(results):
            rendered = route_table(results, route, variant)
            if rendered is None:
                continue
            title = f"{heading} {route_title(results, route)} route {VARIANT_TITLES[variant]}"
            sections.append(f"{title}\n\n{rendered}")
    return sections


def table_sections(results: dict, heading: str) -> str:
    connections = integer(headline_connections(results))
    sections = []
    for level in pipelining_levels(results):
        sections.append(f"{heading} {load_title(level)}")
        sections.extend(_load_sections(pipelining_view(results, level), f"{heading}#"))
    note = (
        f"In each table, the servers appear in the order of their requests a second at {connections} connections. In the "
        "last column, you can read each server's highest rate across every connection count, with the connections at "
        "which the server reached that rate."
    )
    return "\n\n".join([note, *sections])
