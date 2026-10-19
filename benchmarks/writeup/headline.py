from __future__ import annotations

from dataclasses import dataclass

from data import REFERENCE_SERVER, SUBJECT_SERVER, at_connections, created_date, headline_connections, rate, server_ids
from render import integer, percent
from sources import Run

SAME_SPEED_LIMIT = 0.0005
NUMBER_WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six"}


@dataclass(frozen=True)
class ReadmeTarget:
    path: str
    benchmarks_link: str


README_TARGETS = (
    ReadmeTarget("README.md", "BENCHMARKS.md"),
    ReadmeTarget("packages/ts/README.md", "https://github.com/assetcorp/uhttp/blob/main/BENCHMARKS.md"),
)


def _count(value: int) -> str:
    return NUMBER_WORDS.get(value, integer(value))


def _against_reference(subject: float, reference: float | None) -> str | None:
    if not reference:
        return None
    gap = subject / reference - 1
    if abs(gap) < SAME_SPEED_LIMIT:
        return "the same rate as uWebSockets.js on its own"
    return f"{percent(abs(gap))} {'faster' if gap > 0 else 'slower'} than uWebSockets.js on its own"


def _others(results: dict, variant: str, connections: int) -> list[float]:
    values = []
    for server in server_ids(results):
        if server in (REFERENCE_SERVER, SUBJECT_SERVER):
            continue
        value = rate(at_connections(results, "plain", variant, server, connections))
        if value is not None:
            values.append(value)
    return values


def _plain_sentence(results: dict, connections: int) -> str | None:
    subject = rate(at_connections(results, "plain", "plain", SUBJECT_SERVER, connections))
    if subject is None:
        return None
    reference = rate(at_connections(results, "plain", "plain", REFERENCE_SERVER, connections))
    clauses = [clause for clause in [_against_reference(subject, reference)] if clause]
    others = _others(results, "plain", connections)
    if others:
        clauses.append(
            f"{subject / max(others):.1f} times the rate of the fastest of the other {_count(len(others))} "
            "frameworks on the benchmark page"
        )
    sentence = (
        f"In the newest recorded run, the suite measured uhttp at {integer(subject)} requests a second on a "
        f"plain-text route at {integer(connections)} connections"
    )
    return f"{sentence}, which was {' and '.join(clauses)}." if clauses else f"{sentence}."


def _secure_sentence(results: dict, connections: int) -> str | None:
    subject = rate(at_connections(results, "plain", "secure", SUBJECT_SERVER, connections))
    if subject is None:
        return None
    reference = rate(at_connections(results, "plain", "secure", REFERENCE_SERVER, connections))
    against = _against_reference(subject, reference)
    sentence = f"With the same security headers on every server, the suite measured uhttp at {integer(subject)} requests a second"
    return f"{sentence}, {against}." if against else f"{sentence}."


def headline_block(run: Run, benchmarks_link: str) -> str:
    results = run.results
    connections = headline_connections(results)
    date = created_date(results)
    model = (run.machine.get("cpu") or {}).get("model") or "an unrecorded CPU"
    system = (run.machine.get("os") or {}).get("name") or "an unrecorded operating system"
    sentences = [
        _plain_sentence(results, connections) if connections is not None else None,
        _secure_sentence(results, connections) if connections is not None else None,
        f"The suite recorded these figures on {date} in run `{run.run_id}`, on the {model} under {system}.",
        f"You'll find every route, every connection count, and the method in [`BENCHMARKS.md`]({benchmarks_link}).",
    ]
    return " ".join(sentence for sentence in sentences if sentence)


def readme_blocks(run: Run, target: ReadmeTarget) -> dict[str, str]:
    return {"headline": headline_block(run, target.benchmarks_link)}
