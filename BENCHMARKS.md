# Benchmarks

On this page, you can compare the number of requests a second that uhttp serves with the rates of uWebSockets.js on its own and of three Node.js frameworks: Hono on its Node.js adapter, Fastify, and Express. A maintainer starts the suite in [`benchmarks/suite/`](benchmarks/suite/) when somebody asks for new figures. From the newest run under [`benchmarks/results/runs/`](benchmarks/results/runs/), the generator in [`benchmarks/writeup/`](benchmarks/writeup/) then writes every number, table, and chart on this page.

<!-- BENCH:run START -->
<!-- BENCH:run END -->

## Peak throughput

The length of each bar is the highest rate that a server reached at any of the connection counts that the suite measured. In the first chart, each server sends only the headers that it sends by default. In the second chart, every server sends the same ten security headers, which you can find under [Security headers](#security-headers).

<!-- BENCH:peak START -->
<!-- BENCH:peak END -->

## Requests a second at 100 connections

In their [benchmark repository](https://github.com/fastify/benchmarks), the maintainers of Fastify measure each framework at 100 connections with 10 pipelined requests on each connection, so the suite reports the same load in these tables. A server with a figure above 100% in the third column served more requests than uWebSockets.js on its own at the same load.

<!-- BENCH:tables START -->
<!-- BENCH:tables END -->

## Across connection counts

Each chart has three panels, for the requests a second, the p99 latency, and the CPU cores that the server process kept busy, at every connection count that the suite measured. Every server handles its requests on one thread, so a server that keeps that thread busy has a value close to 1 in the bottom panel.

<!-- BENCH:sweep START -->
<!-- BENCH:sweep END -->

## Latency at each server's peak

h2load measures the time from the first byte of a request to the last byte of its response. Because h2load sends 10 pipelined requests on each connection, that time includes the wait behind the earlier requests on the same connection. Each server reached its peak at its own connection count, which you can read beside its line, so compare the lines of two servers only where their counts match.

<!-- BENCH:latency START -->
<!-- BENCH:latency END -->

## Method

### The routes

Every server serves three routes with the same status, media type, and body:

- `GET /plain` returns `Hello, World!` as `text/plain`.
- `GET /json` returns `{"hello":"world"}` as `application/json`.
- `POST /upload` reads a 16 KiB body of `application/octet-stream` and returns its length as `{"bytes":16384}`.

Before it measures a server, the suite sends one request to each route. It then compares the status, the media type, and the body with the list above, and the security headers with the table under [Security headers](#security-headers). When a reply differs, the suite stops that server and records the fault in `results.json`. After a run with a fault, the suite leaves this page unchanged.

### The servers

Each server handles its requests on one thread, in a process of its own that the suite starts afresh for every route and every set of headers.

- uWebSockets.js on its own writes each reply in its route handler, where it passes every fixed header name and value as an `ArrayBuffer` that it builds once at start-up, as uhttp does. On the upload route, it copies each chunk of the body before uWebSockets.js frees it, and it joins the chunks into one buffer, as uhttp does, so that every server holds the whole body before it replies.
- uhttp builds its routes with `createApp()`, serves them with `serve()`, and reads the upload with `c.req.body.bytes()`.
- Hono serves its routes through `@hono/node-server` and reads the upload with `c.req.arrayBuffer()`.
- Fastify gives the JSON route a response schema, as the benchmark repository of Fastify does, and reads the upload with a content-type parser that collects the body into a buffer.
- Express reads the upload with `express.raw()` and sends the plain-text reply with `res.type('text/plain')`.

### Security headers

In the second measurement of each route, every server sends these ten headers on every response:

| Header | Value |
| --- | --- |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Origin-Agent-Cluster` | `?1` |
| `Referrer-Policy` | `no-referrer` |
| `X-Content-Type-Options` | `nosniff` |
| `X-DNS-Prefetch-Control` | `off` |
| `X-Download-Options` | `noopen` |
| `X-Frame-Options` | `SAMEORIGIN` |
| `X-Permitted-Cross-Domain-Policies` | `none` |
| `X-XSS-Protection` | `0` |

These ten headers make up the `web` preset of the `secureHeaders()` middleware of uhttp. uhttp sends them through `secureHeaders()`, Hono through `secureHeaders()` from `hono/secure-headers`, Fastify through `@fastify/helmet`, and Express through `helmet`, while uWebSockets.js on its own writes them in each route handler. uhttp sends `Strict-Transport-Security` only over TLS, so the suite switches that header off in Hono, `@fastify/helmet`, and `helmet`. It also switches off `Content-Security-Policy` in `@fastify/helmet` and `helmet`, because neither uhttp nor Hono sends that header by default.

### Load

<!-- BENCH:settings START -->
<!-- BENCH:settings END -->

The maintainers of Fastify send their load with autocannon, a load generator that is written in JavaScript. This suite sends the same number of connections and pipelined requests with h2load from [nghttp2](https://github.com/nghttp2/nghttp2), because a load generator that is slower than the fastest server can measure that server only at its own speed. In the measurement under [Check a change](CONTRIBUTING.md#check-a-change), autocannon sent about 320,000 requests a second to uWebSockets.js on its own, while h2load sent about 390,000.

### The machine

<!-- BENCH:machine START -->
<!-- BENCH:machine END -->

### Reproduce a run

Install h2load 1.69.0 or later, because the suite reads the median and the percentiles of the request times, which h2load has printed since that version. On macOS, `brew install nghttp2` installs it. Ubuntu 24.04 packages h2load 1.59.0, so on Ubuntu, build h2load from the nghttp2 release as [`benchmarks/cloud/remote-bootstrap.sh`](benchmarks/cloud/remote-bootstrap.sh) does. Install [uv](https://docs.astral.sh/uv/) as well, since the suite starts the generator through it. Then start the suite from the root of the repository:

```bash
pnpm install
pnpm --dir benchmarks/suite bench
```

The suite builds uhttp and measures every server. It then writes a directory under `benchmarks/results/runs/`, named by the UTC time at which the suite started the run, with `machine.json`, `results.json`, `comparison.md`, and a `charts/` directory. When every measurement succeeds, the suite then rewrites this page and the `BENCH:headline` region of both READMEs. With the default settings, the suite starts 30 server processes and applies load to each of them for 240 seconds, which covers 40 seconds of warm-up and 40 seconds at each of five connection counts.

When you record a run on your own computer, the figures describe that computer alone, so record a run for this page on a cloud machine that anybody can rent. The toolkit in [`benchmarks/cloud/`](benchmarks/cloud/README.md) creates a machine on GCP, Hetzner, DigitalOcean, or AWS and starts the suite on it. Once the suite finishes, the toolkit copies the new run directory back into this repository. When you call `./run-cloud.sh all` from `benchmarks/cloud/`, the toolkit records the published profile on a GCP `c3-standard-8`. You can find the default machine of each of the other providers in the README of the toolkit.

To check that the suite works on your machine, start the smoke profile with `pnpm --dir benchmarks/suite bench:smoke`. In the smoke profile, the suite warms each server up for 1 second and measures it for 2 seconds at 10 and at 100 connections. The suite then writes the smoke run under `benchmarks/results/.smoke/runs/`, which git ignores and the generator never reads, so this page stays unchanged. You can find every option of the suite in [`benchmarks/README.md`](benchmarks/README.md).

Commit the new run directory together with this page and both READMEs. The CI job `Benchmark writeup up to date` regenerates the page, the READMEs, the comparison, and the charts from the newest committed run, and it fails when any of them differs from the committed file.
