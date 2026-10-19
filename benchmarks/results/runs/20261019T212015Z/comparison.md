# Benchmark run 20261019T212015Z

The suite recorded this run at 2026-10-19T21:20:15.113Z.

## Machine

- The machine was GCP c3-standard-8, us-central1-a.
- The CPU was the Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz, with 8 logical cores.
- The machine had 31.3 GiB of memory.
- The operating system was Ubuntu 24.04.5 LTS, with kernel 7.0.0-1014-gcp on x64.
- The suite used Node.js 24.22.0 and h2load 1.70.0 from nghttp2.
- The suite pinned each server to CPU 1 and h2load to CPUs 2-5 with `taskset`.
- The suite measured `uWebSockets.js` 20.71.0, `@delali/uhttp` 0.1.0 with `uWebSockets.js` 20.71.0, `hono` 4.13.13 with `@hono/node-server` 2.1.5, `fastify` 5.12.7 with `@fastify/helmet` 13.2.0, and `express` 5.3.0 with `helmet` 8.3.0.
- The suite built uhttp from commit `a2d4d757bf4c`.

## Load

h2load sent each request over HTTP/1.1 from 4 threads, with 10 pipelined requests on each connection. For each server, route, and header setting, the suite started a new server process and checked its replies to all three routes. It then warmed the server up for 40 seconds at 100 connections, and measured it for 40 seconds at each of 10, 50, 100, 250, and 500 connections. h2load sent a 16 KiB body with every request to the upload route. The suite counted the CPU time of each server process during each measurement and divided it by the time that the measurement took, so a server that kept one core busy for the whole measurement had a value of 1.

## Results

In each table, the servers appear in the order of their requests a second at 100 connections. In the last column, you can read each server's highest rate across every connection count, with the connections at which the server reached that rate.

### Plain text route without security headers

| Server | Requests a second | Share of the uWebSockets.js rate | p50 (ms) | p99 (ms) | Server CPU cores | Peak requests a second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uWebSockets.js | 664,229 | 100.0% | 1.50 | 1.78 | 1.00 | 664,229 at 100 |
| uhttp | 521,912 | 78.6% | 2.05 | 2.39 | 1.00 | 521,912 at 100 |
| Fastify | 98,220 | 14.8% | 10.0 | 11.8 | 1.00 | 107,534 at 50 |
| Hono | 95,413 | 14.4% | 10.5 | 11.2 | 1.00 | 105,035 at 50 |
| Express | 64,810 | 9.8% | 15.8 | 18.0 | 1.00 | 68,699 at 50 |

### JSON route without security headers

| Server | Requests a second | Share of the uWebSockets.js rate | p50 (ms) | p99 (ms) | Server CPU cores | Peak requests a second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uWebSockets.js | 565,257 | 100.0% | 1.76 | 2.22 | 1.00 | 565,257 at 100 |
| uhttp | 447,439 | 79.2% | 2.36 | 2.75 | 1.00 | 455,163 at 10 |
| Fastify | 98,504 | 17.4% | 10.3 | 12.0 | 1.00 | 110,141 at 50 |
| Hono | 97,351 | 17.2% | 10.8 | 12.6 | 1.00 | 101,384 at 50 |
| Express | 61,697 | 10.9% | 16.4 | 17.2 | 1.00 | 65,794 at 50 |

### 16 KiB upload route without security headers

| Server | Requests a second | Share of the uWebSockets.js rate | p50 (ms) | p99 (ms) | Server CPU cores | Peak requests a second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uWebSockets.js | 81,629 | 100.0% | 1.20 | 1.74 | 1.00 | 81,629 at 100 |
| uhttp | 50,889 | 62.3% | 1.96 | 2.56 | 1.00 | 52,171 at 50 |
| Fastify | 32,588 | 39.9% | 2.34 | 11.8 | 1.00 | 34,012 at 10 |
| Hono | 27,044 | 33.1% | 3.03 | 12.5 | 1.00 | 28,171 at 50 |
| Express | 23,693 | 29.0% | 3.85 | 11.8 | 1.00 | 25,192 at 250 |

### Plain text route with security headers

| Server | Requests a second | Share of the uWebSockets.js rate | p50 (ms) | p99 (ms) | Server CPU cores | Peak requests a second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uWebSockets.js | 572,430 | 100.0% | 1.81 | 3.34 | 1.00 | 605,234 at 50 |
| uhttp | 464,383 | 81.1% | 2.30 | 2.49 | 1.00 | 464,383 at 100 |
| Fastify | 66,504 | 11.6% | 15.4 | 17.3 | 1.00 | 69,202 at 250 |
| Hono | 56,132 | 9.8% | 17.5 | 20.1 | 1.00 | 57,336 at 50 |
| Express | 47,334 | 8.3% | 21.0 | 23.1 | 1.00 | 51,475 at 50 |

### JSON route with security headers

| Server | Requests a second | Share of the uWebSockets.js rate | p50 (ms) | p99 (ms) | Server CPU cores | Peak requests a second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uWebSockets.js | 557,129 | 100.0% | 1.82 | 2.10 | 1.00 | 557,129 at 100 |
| uhttp | 404,878 | 72.7% | 2.39 | 3.10 | 1.00 | 404,878 at 100 |
| Fastify | 65,593 | 11.8% | 15.8 | 16.5 | 1.00 | 70,046 at 50 |
| Hono | 52,313 | 9.4% | 19.4 | 20.2 | 1.00 | 54,598 at 50 |
| Express | 50,208 | 9.0% | 19.7 | 23.0 | 1.00 | 51,778 at 50 |

### 16 KiB upload route with security headers

| Server | Requests a second | Share of the uWebSockets.js rate | p50 (ms) | p99 (ms) | Server CPU cores | Peak requests a second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uWebSockets.js | 79,914 | 100.0% | 1.23 | 1.65 | 1.00 | 80,683 at 250 |
| uhttp | 56,189 | 70.3% | 1.76 | 2.18 | 1.00 | 57,357 at 50 |
| Fastify | 24,207 | 30.3% | 3.25 | 14.2 | 1.00 | 26,521 at 50 |
| Hono | 23,759 | 29.7% | 4.35 | 5.19 | 1.00 | 28,533 at 50 |
| Express | 21,846 | 27.3% | 4.02 | 13.0 | 1.00 | 21,846 at 100 |
