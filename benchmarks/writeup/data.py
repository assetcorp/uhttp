from __future__ import annotations

from render import integer, is_number, kibibytes

ROUTES = ("plain", "json", "upload")
VARIANTS = ("plain", "secure")
REFERENCE_SERVER = "uws"
SUBJECT_SERVER = "uhttp"
PERCENTILES = (("p50_ms", "p50"), ("p95_ms", "p95"), ("p99_ms", "p99"), ("max_ms", "max"))
VARIANT_TITLES = {"plain": "without security headers", "secure": "with security headers"}


def route_title(results: dict, route: str) -> str:
    if route == "plain":
        return "Plain text"
    if route == "json":
        return "JSON"
    size = (results.get("settings") or {}).get("upload_body_bytes")
    return f"{kibibytes(size)} upload" if is_number(size) else "Upload"


def created_date(results: dict) -> str:
    created = results.get("created_at")
    return created[:10] if isinstance(created, str) and created else "an unrecorded date"


def server_ids(results: dict) -> list[str]:
    return [entry["id"] for entry in results.get("servers") or [] if isinstance(entry.get("id"), str)]


def server_name(results: dict, server: str) -> str:
    for entry in results.get("servers") or []:
        if entry.get("id") == server and isinstance(entry.get("name"), str):
            return entry["name"]
    return server


def rows(results: dict, route: str, variant: str, server: str) -> list[dict]:
    found = [
        item
        for item in results.get("measurements") or []
        if item.get("route") == route and item.get("headers") == variant and item.get("server") == server
    ]
    return sorted(found, key=lambda item: item.get("connections") or 0)


def at_connections(results: dict, route: str, variant: str, server: str, connections: int) -> dict | None:
    return next((item for item in rows(results, route, variant, server) if item.get("connections") == connections), None)


def peak(results: dict, route: str, variant: str, server: str) -> dict | None:
    found = rows(results, route, variant, server)
    return max(found, key=lambda item: item.get("requests_per_second") or 0.0, default=None)


def rate(item: dict | None) -> float | None:
    value = (item or {}).get("requests_per_second")
    return float(value) if is_number(value) else None


def headline_connections(results: dict) -> int | None:
    value = (results.get("settings") or {}).get("headline_connections")
    return value if isinstance(value, int) else None


def connection_levels(results: dict) -> list[int]:
    levels = {item.get("connections") for item in results.get("measurements") or []}
    return sorted(level for level in levels if isinstance(level, int))


def variants_present(results: dict) -> list[str]:
    seen = {item.get("headers") for item in results.get("measurements") or []}
    return [variant for variant in VARIANTS if variant in seen]


def routes_present(results: dict) -> list[str]:
    seen = {item.get("route") for item in results.get("measurements") or []}
    return [route for route in ROUTES if route in seen]


def pipelining_levels(results: dict) -> list[int]:
    seen = {item.get("pipelined_requests") for item in results.get("measurements") or []}
    return sorted(level for level in seen if isinstance(level, int))


def pipelining_view(results: dict, level: int) -> dict:
    settings = results.get("settings") or {}
    return {
        **results,
        "settings": {**settings, "pipelined_requests": level},
        "measurements": [item for item in results.get("measurements") or [] if item.get("pipelined_requests") == level],
        "failures": [item for item in results.get("failures") or [] if item.get("pipelined_requests") == level],
    }


def pipelining_of(results: dict) -> int | None:
    value = (results.get("settings") or {}).get("pipelined_requests")
    return value if isinstance(value, int) else None


def load_phrase(level: object) -> str:
    if level == 1:
        return "one request at a time on each connection"
    return f"{integer(level)} pipelined requests on each connection"


def load_caption(level: object) -> str:
    phrase = load_phrase(level)
    return phrase[:1].upper() + phrase[1:]


def load_title(level: object) -> str:
    return "Without pipelining" if level == 1 else f"With {integer(level)} pipelined requests on each connection"
