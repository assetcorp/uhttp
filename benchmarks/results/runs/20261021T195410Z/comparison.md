# Benchmark run 20261021T195410Z

The suite recorded this run at 2026-10-21T19:54:10.046Z.

## Machine

- The machine was GCP c3-standard-8, us-central1-a.
- The CPU was the Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz, with 8 logical cores.
- The machine had 31.3 GiB of memory.
- The operating system was Ubuntu 24.04.5 LTS, with kernel 7.0.0-1014-gcp on x64.
- The suite used Node.js 24.22.1 and h2load 1.70.0 from nghttp2.
- The suite pinned each server to CPU 1 and h2load to CPUs 2-5 with `taskset`.
- The suite measured `uWebSockets.js` 20.71.0, `@delali/uhttp` 0.1.1 with `uWebSockets.js` 20.71.0, `hono` 4.13.13 with `@hono/node-server` 2.1.5, `fastify` 5.12.7 with `@fastify/helmet` 13.2.0, and `express` 5.3.0 with `helmet` 8.3.0.
- The suite built uhttp from commit `6ae4740a995b`.

## Load

h2load sent each request over HTTP/1.1 from 4 threads. The suite measured every server under each of these loads in turn: one request at a time on each connection and 10 pipelined requests on each connection. For each load, server, route, and header setting, the suite started a new server process and checked its replies to all three routes. It then warmed the server up for 40 seconds at 100 connections under the same load, and measured it for 40 seconds at each of 10, 50, 100, 250, and 500 connections. h2load sent a 16 KiB body with every request to the upload route. The suite counted the CPU time of each server process during each measurement and divided it by the time that the measurement took, so a server that kept one core busy for the whole measurement had a value of 1.

## Results

In each table, the servers appear in the order of their requests a second at 100 connections. In the last column, you can read each server's highest rate across every connection count, with the connections at which the server reached that rate.

### Without pipelining

#### Plain text route without security headers

| Server | Requests a second | Share of the uWebSockets.js rate | p50 (ms) | p99 (ms) | Server CPU cores | Peak requests a second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uWebSockets.js | 161,565 | 100.0% | 0.60 | 1.09 | 1.00 | 162,731 at 250 |
| uhttp | 153,147 | 94.8% | 0.64 | 0.82 | 1.00 | 156,280 at 50 |
| Fastify | 67,272 | 41.6% | 1.53 | 1.88 | 1.00 | 67,272 at 100 |
| Hono | 66,724 | 41.3% | 1.50 | 1.80 | 1.00 | 69,207 at 50 |
| Express | 42,819 | 26.5% | 2.28 | 2.82 | 1.00 | 42,911 at 10 |

#### JSON route without security headers

| Server | Requests a second | Share of the uWebSockets.js rate | p50 (ms) | p99 (ms) | Server CPU cores | Peak requests a second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uWebSockets.js | 155,869 | 100.0% | 0.66 | 0.81 | 1.00 | 155,869 at 100 |
| uhttp | 147,312 | 94.5% | 0.67 | 0.82 | 1.00 | 147,312 at 100 |
| Fastify | 71,502 | 45.9% | 1.41 | 1.67 | 1.00 | 71,502 at 100 |
| Hono | 66,340 | 42.6% | 1.49 | 1.73 | 1.00 | 69,023 at 50 |
| Express | 47,695 | 30.6% | 2.13 | 2.40 | 1.00 | 49,861 at 50 |

#### 16 KiB upload route without security headers

| Server | Requests a second | Share of the uWebSockets.js rate | p50 (ms) | p99 (ms) | Server CPU cores | Peak requests a second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uWebSockets.js | 73,969 | 100.0% | 1.32 | 1.90 | 1.00 | 73,969 at 100 |
| uhttp | 56,739 | 76.7% | 1.75 | 2.31 | 1.00 | 61,039 at 50 |
| Fastify | 33,036 | 44.7% | 2.37 | 12.3 | 1.00 | 33,036 at 100 |
| Hono | 27,892 | 37.7% | 2.83 | 12.7 | 1.00 | 27,892 at 100 |
| Express | 25,181 | 34.0% | 3.33 | 12.2 | 1.00 | 25,736 at 50 |

#### Plain text route with security headers

| Server | Requests a second | Share of the uWebSockets.js rate | p50 (ms) | p99 (ms) | Server CPU cores | Peak requests a second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uWebSockets.js | 158,285 | 100.0% | 0.67 | 0.83 | 1.00 | 158,285 at 100 |
| uhttp | 150,679 | 95.2% | 0.66 | 0.80 | 1.00 | 150,679 at 100 |
| Fastify | 45,090 | 28.5% | 2.17 | 2.68 | 1.00 | 45,090 at 100 |
| Hono | 40,530 | 25.6% | 2.51 | 2.94 | 1.00 | 40,530 at 100 |
| Express | 36,922 | 23.3% | 2.66 | 3.23 | 1.00 | 43,489 at 50 |

#### JSON route with security headers

| Server | Requests a second | Share of the uWebSockets.js rate | p50 (ms) | p99 (ms) | Server CPU cores | Peak requests a second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uWebSockets.js | 140,341 | 100.0% | 0.68 | 1.28 | 1.00 | 153,887 at 500 |
| uhttp | 135,583 | 96.6% | 0.73 | 0.94 | 1.00 | 135,583 at 100 |
| Fastify | 44,144 | 31.5% | 2.27 | 3.81 | 1.00 | 44,144 at 100 |
| Hono | 36,141 | 25.8% | 2.74 | 3.27 | 1.00 | 37,168 at 50 |
| Express | 36,051 | 25.7% | 2.81 | 3.21 | 1.00 | 39,389 at 50 |

#### 16 KiB upload route with security headers

| Server | Requests a second | Share of the uWebSockets.js rate | p50 (ms) | p99 (ms) | Server CPU cores | Peak requests a second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uWebSockets.js | 74,598 | 100.0% | 1.28 | 1.84 | 1.00 | 74,598 at 100 |
| uhttp | 57,630 | 77.3% | 1.71 | 2.19 | 1.00 | 58,817 at 50 |
| Fastify | 25,384 | 34.0% | 3.09 | 14.5 | 1.00 | 27,096 at 50 |
| Hono | 24,938 | 33.4% | 3.84 | 12.7 | 1.00 | 25,354 at 50 |
| Express | 20,454 | 27.4% | 4.20 | 13.7 | 1.00 | 21,433 at 10 |

### With 10 pipelined requests on each connection

#### Plain text route without security headers

| Server | Requests a second | Share of the uWebSockets.js rate | p50 (ms) | p99 (ms) | Server CPU cores | Peak requests a second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uWebSockets.js | 571,333 | 100.0% | 1.54 | 2.06 | 1.00 | 608,476 at 50 |
| uhttp | 494,071 | 86.5% | 1.87 | 2.36 | 1.00 | 555,562 at 250 |
| Fastify | 107,185 | 18.8% | 9.26 | 11.0 | 1.00 | 109,929 at 50 |
| Hono | 101,558 | 17.8% | 10.5 | 11.2 | 1.00 | 103,390 at 50 |
| Express | 67,774 | 11.9% | 14.4 | 17.8 | 1.00 | 68,461 at 500 |

#### JSON route without security headers

| Server | Requests a second | Share of the uWebSockets.js rate | p50 (ms) | p99 (ms) | Server CPU cores | Peak requests a second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uWebSockets.js | 520,008 | 100.0% | 1.99 | 2.10 | 1.00 | 520,008 at 100 |
| uhttp | 425,490 | 81.8% | 2.26 | 2.67 | 1.00 | 470,448 at 250 |
| Hono | 100,713 | 19.4% | 9.77 | 12.8 | 1.00 | 103,258 at 50 |
| Fastify | 93,676 | 18.0% | 10.7 | 12.2 | 1.00 | 107,581 at 50 |
| Express | 60,667 | 11.7% | 16.6 | 18.4 | 1.00 | 66,255 at 50 |

#### 16 KiB upload route without security headers

| Server | Requests a second | Share of the uWebSockets.js rate | p50 (ms) | p99 (ms) | Server CPU cores | Peak requests a second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uWebSockets.js | 77,603 | 100.0% | 1.24 | 1.70 | 1.00 | 78,258 at 250 |
| uhttp | 63,816 | 82.2% | 1.53 | 1.95 | 1.00 | 63,816 at 100 |
| Fastify | 29,435 | 37.9% | 2.75 | 11.9 | 1.00 | 31,436 at 50 |
| Hono | 28,044 | 36.1% | 2.97 | 11.5 | 1.00 | 29,035 at 10 |
| Express | 24,529 | 31.6% | 3.40 | 11.7 | 1.00 | 24,529 at 100 |

#### Plain text route with security headers

| Server | Requests a second | Share of the uWebSockets.js rate | p50 (ms) | p99 (ms) | Server CPU cores | Peak requests a second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uWebSockets.js | 600,874 | 100.0% | 1.61 | 3.20 | 1.00 | 600,874 at 100 |
| uhttp | 464,851 | 77.4% | 2.12 | 2.59 | 1.00 | 530,052 at 50 |
| Fastify | 66,360 | 11.0% | 15.5 | 17.5 | 1.00 | 69,493 at 50 |
| Hono | 51,928 | 8.6% | 19.3 | 21.9 | 1.00 | 55,836 at 50 |
| Express | 49,346 | 8.2% | 21.2 | 22.1 | 1.00 | 51,794 at 50 |

#### JSON route with security headers

| Server | Requests a second | Share of the uWebSockets.js rate | p50 (ms) | p99 (ms) | Server CPU cores | Peak requests a second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uWebSockets.js | 498,530 | 100.0% | 1.99 | 2.37 | 1.00 | 498,530 at 100 |
| uhttp | 423,899 | 85.0% | 2.28 | 2.73 | 1.00 | 423,899 at 100 |
| Fastify | 67,569 | 13.6% | 15.4 | 17.0 | 1.00 | 69,653 at 250 |
| Express | 50,957 | 10.2% | 19.5 | 21.7 | 1.00 | 50,957 at 100 |
| Hono | 49,338 | 9.9% | 19.8 | 24.2 | 1.00 | 55,965 at 50 |

#### 16 KiB upload route with security headers

| Server | Requests a second | Share of the uWebSockets.js rate | p50 (ms) | p99 (ms) | Server CPU cores | Peak requests a second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uWebSockets.js | 79,651 | 100.0% | 1.21 | 1.72 | 1.00 | 79,651 at 100 |
| uhttp | 62,962 | 79.0% | 1.54 | 2.01 | 1.00 | 65,932 at 50 |
| Hono | 20,605 | 25.9% | 3.92 | 14.9 | 1.00 | 26,697 at 10 |
| Express | 20,505 | 25.7% | 4.13 | 13.8 | 1.00 | 21,181 at 10 |
| Fastify | 18,465 | 23.2% | 3.76 | 24.8 | 1.00 | 21,511 at 500 |
