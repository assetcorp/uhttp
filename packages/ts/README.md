![uhttp, an HTTP and WebSocket server for Node.js on uWebSockets.js](https://raw.githubusercontent.com/assetcorp/uhttp/main/assets/banner.png)

# uhttp

[![CI](https://github.com/assetcorp/uhttp/actions/workflows/ci.yml/badge.svg)](https://github.com/assetcorp/uhttp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@delali/uhttp)](https://www.npmjs.com/package/@delali/uhttp)
[![downloads](https://img.shields.io/npm/dw/@delali/uhttp)](https://www.npmjs.com/package/@delali/uhttp)
[![types](https://img.shields.io/badge/types-TypeScript-blue)](https://www.npmjs.com/package/@delali/uhttp)
[![license](https://img.shields.io/npm/l/@delali/uhttp)](https://github.com/assetcorp/uhttp/blob/main/LICENSE)

uhttp is an HTTP and WebSocket server for Node.js on uWebSockets.js. With it, you can add routes and WebSocket routes, put middleware such as a login check in front of them, parse JSON bodies and file uploads, and build replies with helpers. Before any asynchronous step, the package copies only the parts of the raw request that the code of a route uses, so that uhttp adds as little work as it can to each request. The speed check on every pull request sends one request at a time on each of 100 connections, and it fails when uhttp serves those requests more than 5% more slowly than uWebSockets.js. On the benchmark page, each connection carries 10 requests at once, so less of the time of each request goes to the network. The work that uhttp adds therefore makes up a larger share of each request there, which is why the page shows a larger gap between uhttp and uWebSockets.js.

<!-- BENCH:headline START -->
In the newest recorded run, the suite measured uhttp at 521,912 requests a second on a plain-text route at 100 connections, which was 21.4% slower than uWebSockets.js and 5.3 times the rate of the fastest of the other three frameworks on the benchmark page. With the same security headers on every server, the suite measured uhttp at 464,383 requests a second, 18.9% slower than uWebSockets.js. The suite recorded these figures on 2026-10-19 in run `20261019T212015Z`, on the Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz under Ubuntu 24.04.5 LTS. You'll find every route, every connection count, and the method in [`BENCHMARKS.md`](https://github.com/assetcorp/uhttp/blob/main/BENCHMARKS.md).
<!-- BENCH:headline END -->

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Features](#features)
- [Documentation](#documentation)
- [Examples](#examples)
- [The uWebSockets.js package on npm](#the-uwebsocketsjs-package-on-npm)
- [Licence](#licence)

## Install

uhttp works on Node.js 22.15 or a later 22 release, on Node.js 24, and on Node.js 26. Install the package from npm:

```bash
pnpm add -E @delali/uhttp
```

You also have to install uWebSockets.js beside uhttp. Its author publishes it on GitHub alone, so give your package manager the release tag on GitHub. With pnpm or Bun, install it with one command:

```bash
pnpm add -E uWebSockets.js@github:uNetworking/uWebSockets.js#v20.71.0
bun add --exact uWebSockets.js@github:uNetworking/uWebSockets.js#v20.71.0
```

npm 12 installs a dependency from GitHub only when you allow one, so pass `--allow-git=root`, which npm 11 accepts as well:

```bash
npm install --save-exact --allow-git=root uWebSockets.js@github:uNetworking/uWebSockets.js#v20.71.0
```

Yarn 4 installs a dependency from GitHub only when you approve its repository first:

```bash
yarn config set --json approvedGitRepositories '["https://github.com/uNetworking/uWebSockets.js.git"]'
yarn add --exact uWebSockets.js@github:uNetworking/uWebSockets.js#v20.71.0
```

The author of uWebSockets.js builds its binaries for Linux with glibc, for macOS, and for Windows alone, so uWebSockets.js throws an error when your app loads it on Alpine Linux or on any other system that uses musl in place of glibc.

## Quick start

```ts
import { createApp, serve } from '@delali/uhttp'
import { secureHeaders } from '@delali/uhttp/secure-headers'

const app = createApp()
  .use(secureHeaders())
  .get('/hello/:name', c => c.json({ hello: c.req.param('name') }))
  .post('/echo', async c => c.json(await c.req.body.json()))

const server = await serve({ app, port: 3000 })

process.once('SIGTERM', async () => {
  await server.close()
})
```

`secureHeaders()` adds the security headers that a browser checks, such as `X-Content-Type-Options: nosniff` and `X-Frame-Options: SAMEORIGIN`, to every response. `server.close()` waits for each request in progress, for up to 10 seconds by default, before it stops the server. The package installs no signal handler of its own, so in the quick start, a handler for `SIGTERM` calls `server.close()` when the process receives that signal.

In a test, you can send a request through the app without opening a port:

```ts
const response = await app.request('/hello/Ama')
console.log(await response.json())
```

## Features

**Routing and middleware.** For every GET route, the package answers a HEAD request with the headers of the GET reply. To a method that a path has no route for, it replies 405 with an `Allow` header, and it replies 204 with the same header to an OPTIONS request for a path that has no OPTIONS route. You can add middleware to the whole app, to a [group of routes](https://github.com/assetcorp/uhttp/blob/main/docs/routing.md), or to one route. When a middleware or a handler throws, the package turns the error into a JSON reply at that point, so that the middleware around it can read the status of that reply after `await next()`.

**Bodies and validation.** A handler can read a body as a stream, or it can [parse the body](https://github.com/assetcorp/uhttp/blob/main/docs/bodies.md) as JSON, text, bytes, or a URL-encoded form, up to a body limit that you can set for each route. `json(schema)` checks the body against a schema from Valibot, Zod, ArkType, or any other validator that implements Standard Schema. For a [multipart upload](https://github.com/assetcorp/uhttp/blob/main/docs/uploads.md), `multipart()` streams each file into a destination that you choose, one chunk at a time.

**Replies.** The [reply helpers](https://github.com/assetcorp/uhttp/blob/main/docs/responses.md) send text, JSON, bytes, redirects, streamed bodies, and server-sent events with a heartbeat.

**WebSockets.** The package sends the upgrade request of a [WebSocket route](https://github.com/assetcorp/uhttp/blob/main/docs/websockets.md) through the same middleware as an HTTP request. When your code publishes a message on a topic, the package delivers it to the subscribers on every worker thread, while a pub/sub adapter, such as one on Redis, can pass it on to other servers.

**Worker threads.** With the [`threads` option](https://github.com/assetcorp/uhttp/blob/main/docs/threads.md), several worker threads serve one port. The main thread starts a replacement for a worker that crashes. When a worker blocks its thread, the main thread closes the port and ends the process, so that a process manager can restart the server.

**Start, stop, and HTTPS.** `serve()` listens on a port or on a Unix socket. `server.close()` [waits for the requests in progress](https://github.com/assetcorp/uhttp/blob/main/docs/start-and-stop.md) for up to a grace period. With `server.reload()`, you can [replace the certificates](https://github.com/assetcorp/uhttp/blob/main/docs/https.md) while the server goes on serving.

**Optional middleware.** The package has ten optional middleware, for trusted proxies, request IDs, access logs, rate limits, security headers, CORS, CSRF protection, cookies, compression, and static files. Each of them has an entry point of its own, such as `@delali/uhttp/cors`, so that a bundler can leave out every middleware that your app doesn't import.

## Documentation

| Guide | What it covers |
| --- | --- |
| [Routing and middleware](https://github.com/assetcorp/uhttp/blob/main/docs/routing.md) | Routes, path parameters, groups, middleware, the request context, and tests without a port |
| [Request bodies and validation](https://github.com/assetcorp/uhttp/blob/main/docs/bodies.md) | The body parsers, Standard Schema validation, body limits, and time limits |
| [Uploads](https://github.com/assetcorp/uhttp/blob/main/docs/uploads.md) | Multipart forms, a destination for each file, and the limits of an upload |
| [Responses](https://github.com/assetcorp/uhttp/blob/main/docs/responses.md) | The reply helpers, response headers, streamed responses, and server-sent events |
| [WebSockets](https://github.com/assetcorp/uhttp/blob/main/docs/websockets.md) | WebSocket routes, the upgrade through middleware, the origin check, the limits of a socket, and pub/sub across threads and servers |
| [Worker threads](https://github.com/assetcorp/uhttp/blob/main/docs/threads.md) | Serving on several threads, the memory of each worker, and a worker that crashes or hangs |
| [Start and stop a server](https://github.com/assetcorp/uhttp/blob/main/docs/start-and-stop.md) | Ports, Unix sockets, a close that drops no request, and a close on a signal |
| [Serve HTTPS](https://github.com/assetcorp/uhttp/blob/main/docs/https.md) | Certificates, several hostnames, and new certificates while the server goes on serving |
| [Errors](https://github.com/assetcorp/uhttp/blob/main/docs/errors.md) | The error codes, the error and not-found handlers, the logger, and the errors that uWebSockets.js sends itself |
| [Deploy behind a proxy](https://github.com/assetcorp/uhttp/blob/main/docs/deployment.md) | HTTP/2 through a reverse proxy, and the proxy settings for the limits that uWebSockets.js sets |
| [Trusted proxies](https://github.com/assetcorp/uhttp/blob/main/docs/middleware/trusted-proxies.md) | The address, the protocol, and the host of a client behind a proxy |
| [Request IDs](https://github.com/assetcorp/uhttp/blob/main/docs/middleware/request-id.md) | An ID on each request, with which you can find a request that a client reports in your logs |
| [Access logs](https://github.com/assetcorp/uhttp/blob/main/docs/middleware/access-log.md) | One line for each request, without the secrets that a request can contain |
| [Rate limits](https://github.com/assetcorp/uhttp/blob/main/docs/middleware/rate-limit.md) | Limits that every worker thread shares, the IETF rate-limit headers, and a store on Redis |
| [Security headers](https://github.com/assetcorp/uhttp/blob/main/docs/middleware/secure-headers.md) | The presets for pages and APIs, HSTS, and a content security policy with a nonce |
| [CORS](https://github.com/assetcorp/uhttp/blob/main/docs/middleware/cors.md) | The origins whose scripts may read your responses, and the replies to preflight requests |
| [CSRF protection](https://github.com/assetcorp/uhttp/blob/main/docs/middleware/csrf.md) | Rejecting a form that another site sends to your app |
| [Cookies](https://github.com/assetcorp/uhttp/blob/main/docs/middleware/cookies.md) | Reading, setting, deleting, and signing cookies |
| [Compression](https://github.com/assetcorp/uhttp/blob/main/docs/middleware/compression.md) | Brotli, zstd, and gzip responses, and the routes that should stay uncompressed |
| [Static files](https://github.com/assetcorp/uhttp/blob/main/docs/middleware/static.md) | Serving a folder with caching, byte ranges, and canonical paths |

You can compare the requests a second of uhttp with those of uWebSockets.js and of other Node.js frameworks in [BENCHMARKS.md](https://github.com/assetcorp/uhttp/blob/main/BENCHMARKS.md). To set up the repository and propose a change, follow [CONTRIBUTING.md](https://github.com/assetcorp/uhttp/blob/main/CONTRIBUTING.md).

## Examples

### Echo every WebSocket message

```ts
import { createApp, serve } from '@delali/uhttp'

const app = createApp().ws('/echo', {
  message: (socket, message) => {
    socket.send(message)
  },
})

await serve({ app, port: 3000 })
```

### Stream each uploaded file to disk

```ts
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { createApp } from '@delali/uhttp'

const app = createApp().post('/photos', { maxBodyBytes: 20 * 1024 * 1024 }, async c => {
  const { fields, files } = await c.req.body.multipart({
    file: () => createWriteStream(join('/var/uploads', randomUUID())),
  })
  return c.json({ caption: fields.caption, stored: files.map(file => file.size) }, 201)
})
```

### Serve one port from four threads

On the main thread, `server.ts` passes `serve()` the URL of the app module:

```ts
import { serve } from '@delali/uhttp'

await serve({ app: new URL('./app.js', import.meta.url), port: 3000, threads: 4 })
```

Each of the four worker threads imports `app.js` and builds its app from the function that the module exports by default:

```ts
import { createApp } from '@delali/uhttp'

export default () => createApp().get('/hello', c => c.text('Hello from a worker.'))
```

## The uWebSockets.js package on npm

A publisher other than the author of uWebSockets.js publishes the npm package `uwebsockets.js`, in lower case, so install uWebSockets.js from GitHub, as [Install](#install) shows.

## Licence

uhttp is under the [MIT licence](https://github.com/assetcorp/uhttp/blob/main/LICENSE). uWebSockets.js is under the Apache License 2.0. Your package manager installs uWebSockets.js beside uhttp, so the uhttp package contains none of its code.
