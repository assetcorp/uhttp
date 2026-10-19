from __future__ import annotations

from render import and_join, gibibytes, integer, is_number, kibibytes
from sources import Run

SERVER_PACKAGE_JOIN = " with "


def _packages_phrase(entry: dict) -> str:
    packages = entry.get("packages") or {}
    return SERVER_PACKAGE_JOIN.join(f"`{name}` {version}" for name, version in packages.items())


def _revision_bullet(results: dict) -> str:
    commit = results.get("uhttp_commit")
    if not isinstance(commit, str) or not commit:
        return "- The suite built uhttp from a commit that it could not record."
    changes = " with uncommitted changes in `packages/ts`" if results.get("uhttp_uncommitted_changes") is True else ""
    return f"- The suite built uhttp from commit `{commit}`{changes}."


def machine_bullets(run: Run) -> list[str]:
    machine = run.machine
    cpu = machine.get("cpu") or {}
    os = machine.get("os") or {}
    tools = machine.get("tools") or {}
    pinning = machine.get("pinning") or {}
    bullets = [
        f"- The CPU was the {cpu.get('model') or 'unrecorded model'}, with {integer(cpu.get('logical_cores'))} logical "
        "cores.",
        f"- The machine had {gibibytes(machine.get('memory_bytes'))} of memory.",
        f"- The operating system was {os.get('name') or 'unrecorded'}, with kernel {os.get('kernel') or 'unrecorded'} "
        f"on {os.get('arch') or 'an unrecorded architecture'}.",
        f"- The suite used Node.js {tools.get('node') or 'unrecorded'} and h2load {tools.get('h2load') or 'unrecorded'} "
        "from nghttp2.",
    ]
    if isinstance(pinning.get("server_cpu"), int) and isinstance(pinning.get("load_cpus"), str):
        bullets.append(
            f"- The suite pinned each server to CPU {pinning['server_cpu']} and h2load to CPUs {pinning['load_cpus']} "
            "with `taskset`."
        )
    else:
        bullets.append("- The suite pinned no process to a CPU, so each server shared the machine's CPUs with h2load.")
    packages = [_packages_phrase(entry) for entry in run.results.get("servers") or []]
    if packages:
        bullets.append(f"- The suite measured {and_join(packages)}.")
    bullets.append(_revision_bullet(run.results))
    return bullets


def _seconds(value: object) -> str:
    if not is_number(value):
        return "an unrecorded number of seconds"
    return "1 second" if value == 1 else f"{integer(value)} seconds"


def settings_sentences(run: Run) -> str:
    settings = run.results.get("settings") or {}
    levels = [integer(level) for level in settings.get("connection_levels") or []]
    upload = kibibytes(settings.get("upload_body_bytes"))
    return (
        f"h2load sent each request over HTTP/1.1 from {integer(settings.get('load_threads'))} threads, with "
        f"{integer(settings.get('pipelined_requests'))} pipelined requests on each connection. For each server, route, and "
        "header setting, the suite started a new server process and checked its replies to all three routes. It then "
        f"warmed the server up for {_seconds(settings.get('warm_up_seconds'))} at "
        f"{integer(settings.get('headline_connections'))} connections, and measured it for "
        f"{_seconds(settings.get('measure_seconds'))} at each of {and_join(levels)} connections. h2load sent a {upload} "
        "body with every request to the upload route. The suite counted the CPU time of each server process during each "
        "measurement and divided it by the time that the measurement took, so a server that kept one core busy scored 1."
    )
