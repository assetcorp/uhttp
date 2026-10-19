from __future__ import annotations

from collections.abc import Sequence

GIBIBYTE_BYTES = 1024**3
KIBIBYTE_BYTES = 1024


def is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def integer(value: object) -> str:
    return f"{round(value):,}" if is_number(value) else "n/a"


def decimal(value: object, places: int) -> str:
    return f"{value:.{places}f}" if is_number(value) else "n/a"


def milliseconds(value: object) -> str:
    if not is_number(value):
        return "n/a"
    return f"{value:.2f}" if value < 10 else f"{value:.1f}"


def gibibytes(value: object) -> str:
    if not is_number(value):
        return "n/a"
    return f"{value / GIBIBYTE_BYTES:.1f}".removesuffix(".0") + " GiB"


def kibibytes(value: object) -> str:
    if not is_number(value):
        return "n/a"
    return f"{value / KIBIBYTE_BYTES:g} KiB"


def percent(value: object, places: int = 1) -> str:
    return f"{value * 100:.{places}f}%" if is_number(value) else "n/a"


def and_join(items: Sequence[str]) -> str:
    parts = list(items)
    if len(parts) < 2:
        return "".join(parts)
    if len(parts) == 2:
        return f"{parts[0]} and {parts[1]}"
    return ", ".join(parts[:-1]) + ", and " + parts[-1]


def table(headers: Sequence[str], aligns: Sequence[str], rows: Sequence[Sequence[str]]) -> str:
    divider = ["---:" if align == "right" else "---" for align in aligns]

    def line(cells: Sequence[str]) -> str:
        return "| " + " | ".join(cells) + " |"

    return "\n".join([line(headers), line(divider), *(line(row) for row in rows)])
