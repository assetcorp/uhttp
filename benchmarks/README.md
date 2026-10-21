# Benchmark suite

The suite in `suite/` measures uhttp, uWebSockets.js, Hono, Fastify, and Express under the same load. From the newest run under `results/runs/`, the generator in `writeup/` writes [`BENCHMARKS.md`](../BENCHMARKS.md), which also describes the method.

## Before you start the suite

Install h2load 1.69.0 or later, which sends the load, because the suite reads the median and the percentiles of the request times that h2load has printed since that version. The suite checks the version before it starts any server. On macOS, `brew install nghttp2` installs it. Ubuntu 24.04 packages h2load 1.59.0, so on Ubuntu, build h2load from the nghttp2 release as [`cloud/remote-bootstrap.sh`](cloud/remote-bootstrap.sh) does. Install [uv](https://docs.astral.sh/uv/) too, because the suite starts the generator through `uv run`. uv then installs the versions of Python and matplotlib that `writeup/pyproject.toml` pins. Then install the workspace from the root of the repository with `pnpm install`.

On Linux with `taskset` and at least 6 CPUs, the suite pins each server to CPU 1 and the 4 threads of h2load to CPUs 2 to 5, so that the server and h2load never share a CPU. On any other machine, the suite pins nothing, which it records in `machine.json`.

## Record a run on a cloud machine

When you record a run on your own computer, the figures describe that computer alone, so record a run for the published page on a cloud machine that anybody can rent. The toolkit in [`cloud/`](cloud/README.md) creates that machine on GCP, Hetzner, DigitalOcean, or AWS, installs what the suite needs, and starts the suite on it in either profile. Once the suite finishes, the toolkit copies the new run directory back into `results/runs/` or `results/.smoke/runs/`:

```bash
cd benchmarks/cloud
PROVIDER=gcp ./run-cloud.sh all
```

## Profiles

The suite reads the profile from the `BENCH_PROFILE` variable and writes each run into the directory of that profile. The `bench` script leaves the variable unset, so the suite uses the published profile and writes the run under `results/runs/`. The `bench:smoke` script sets `BENCH_PROFILE=smoke`, so the suite writes the run under `results/.smoke/runs/`:

```bash
pnpm --dir benchmarks/suite bench
pnpm --dir benchmarks/suite bench:smoke
```

In the published profile, the suite measures every server, every route, and both sets of headers, with 40 seconds of warm-up and 40 seconds at each of 10, 50, 100, 250, and 500 connections. It measures all of them first with one request at a time on each connection, and then again with 10 pipelined requests on each connection. When every measurement succeeds, the suite rewrites `BENCHMARKS.md` and the `BENCH:headline` region of both READMEs from the new run. The suite refuses to leave out a server, a route, or a set of headers in the published profile, because you will then find only some of the servers on the page.

In the smoke profile, the suite warms each server up for 1 second and measures it for 2 seconds at 10 and at 100 connections, so that you can check that the suite works on your machine. Git ignores `results/.smoke/`, and the generator reads `results/runs/` alone, so the page and the READMEs stay unchanged after a smoke run. The suite still writes `comparison.md` and the charts into each smoke run, so that you can read them. Delete the smoke runs with `rm -rf benchmarks/results/.smoke` once you no longer need them.

## Options

Pass each option after the name of the script, as in `pnpm --dir benchmarks/suite bench:smoke --servers uhttp,uws`:

| Option | What it sets | Default |
| --- | --- | --- |
| `--servers` | A comma-separated list of the servers to measure, from `uws`, `uhttp`, `hono`, `fastify`, and `express` | Every server |
| `--routes` | A comma-separated list of the routes to measure, from `plain`, `json`, and `upload` | Every route |
| `--headers` | A comma-separated list of the sets of headers, from `plain`, which leaves the security headers out, and `secure`, which adds them | Both sets |
| `--connections` | A comma-separated list of the connection counts | `10,50,100,250,500`, or `10,100` in the smoke profile |
| `--pipelining` | A comma-separated list of the numbers of requests that h2load keeps in flight on each connection, where 1 sends one request at a time and a larger number pipelines that many requests | `1,10` |
| `--duration` | The seconds of load at each connection count | 40, or 2 in the smoke profile |
| `--warm-up` | The seconds of load at 100 connections before the first measurement | 40, or 1 in the smoke profile |
| `--threads` | The threads of h2load, up to the number of connections | 4 |

The suite accepts `--servers`, `--routes`, and `--headers` in the smoke profile alone, since it measures every server, route, and set of headers in the published profile.

## The files of a run

For each run, the suite writes a directory whose name is the UTC time at which the suite started the run, such as `20261019T004707Z`:

- In `machine.json`, the suite records the label from `BENCH_MACHINE_LABEL` when you set it, the CPU, the memory, the operating system, the versions of Node.js and h2load, and the CPUs to which it pinned each process.
- In `results.json`, the suite records the settings, the version of each server, and every measurement, together with each failure.
- In `comparison.md`, the generator writes the tables of the run, and in `charts/`, it draws the charts, each with the name of the run directory in its caption.

When the reply of a server differs from the expected reply, or when h2load reports a failed request, the suite records the failure in `results.json` and exits with code 1, so `BENCHMARKS.md` stays unchanged.

## Redraw the page

To rewrite `BENCHMARKS.md` and the READMEs from the newest committed run without measuring anything, start the generator from `benchmarks/writeup/`:

```bash
uv run --frozen python generate.py
```

With `--check`, the generator builds every page in memory and draws the comparison and the charts into a temporary directory. It then exits with code 1 when any of them differs from the committed file. The CI job `Benchmark writeup up to date` makes that check on every push to main and on every pull request.
