# Worker threads

One Node.js thread serves every request by default. With `threads`, the main thread accepts each connection and hands it to one of several worker threads, and each worker builds its own app from a module that you name. Requests then use every CPU core that you give the server, while the process keeps one port.

```ts
// server.ts
import { serve } from '@delali/uhttp'

const server = await serve({ app: new URL('./app.js', import.meta.url), port: 3000, threads: 4 })
```

```ts
// app.js
import { createApp } from '@delali/uhttp'

export default () => createApp().get('/hello', c => c.text('Hello from a worker.'))
```

## Write the app module

The default export of the module is the app from `createApp()`, or a function that returns the app or a promise of it. Each worker imports the module once and builds its app from it, while `server.ts` runs once, on the main thread. Pass the URL of the module, because a worker can't receive an app object from the main thread. `serve()` throws `INVALID_SERVE_OPTIONS` when you pass `threads` with an app object or with a Unix socket path, and when you pass `workerHeapMb` without `threads`.

When the module throws, or its default export returns no app, during the first start, `serve()` rejects with `APP_START_FAILED`. Its `cause` holds the error of the worker, and the package stops the other workers and listens on no port.

With `threads` at 0, which is the default, `serve()` imports the module on the main thread and serves every request there.

## Each worker has its own memory

Every worker runs its own copy of the module, with its own variables, caches, and connections to a database. A `Map` that one worker fills stays empty on every other worker, so keep shared state, such as sessions or a rate-limit counter, in a database or a store such as Redis. A WebSocket publish reaches the subscribers on every worker, as [WebSockets](websockets.md) describes.

`workerHeapMb` sets the largest main heap of each worker in megabytes, through the `maxOldGenerationSizeMb` resource limit of Node.js:

```ts
await serve({ app: new URL('./app.js', import.meta.url), port: 3000, threads: 4, workerHeapMb: 512 })
```

When a worker that holds open connections runs out of memory, Node.js aborts the whole process with `SIGABRT`, and every connection on every worker closes. Node.js ends a worker that passes its heap limit, and it then finds the sockets that uWebSockets.js still has open on the event loop of that worker. Run the server under a process manager such as systemd or Kubernetes, which starts it again, and size `workerHeapMb` so that a worker stays well below it.

## A worker that crashes

When code on a worker throws an error that nothing catches, or a promise rejects without a handler, the worker sends the error to the main thread, closes its own connections, and exits. The main thread logs 'A worker thread crashed.' with the error under `err`, and it keeps handing new connections to the other workers.

The main thread starts a replacement 1 second after the first crash. While the replacements keep failing, it doubles that delay up to 1 minute. Once a replacement has served for 30 seconds, the delay returns to 1 second. While no worker serves, the main thread answers each request with a 503.

The server exits with code 1 when every worker is dead, or when workers crash `crashLimit` times within `crashWindowMs`, which is 5 crashes within 10 seconds by default. Before it exits, the main thread closes the port and gives each healthy worker up to 5 seconds to close its connections.

## A worker that hangs

A worker that runs a loop without an end, or blocks its thread for a long time, answers no request on its connections. The main thread therefore pings each worker six times within `watchdogMs`, which is 30 seconds by default. When a worker fails to answer for that long, the main thread logs 'A worker thread failed to answer for 30000 ms.', closes the port, and ends the process with an error.

Node.js can't end a hung worker cleanly while uWebSockets.js has sockets open on its event loop, so the process ends with `SIGABRT` in that case, as it does for a worker out of memory. Run the server under a process manager that starts it again. Raise `watchdogMs` when a route blocks its thread for longer on purpose, and set it to 0 to switch the watchdog off, in which case a hung worker holds its connections until the process ends.

## Logs

The main thread writes each crash, each hang, and each exit with an error to the `logger` that you pass to `serve()`, which takes the same `info`, `warn`, and `error` methods as the logger of an app. It writes them to the console when you leave the logger out. Each worker logs the errors of its requests to the logger of its own app.

## Close the server

`server.close()` closes the port, then asks each worker to leave. A worker first tells the main thread that it is leaving, the main thread stops handing it connections, and the worker then closes its connections and exits. The promise resolves once every worker has exited.
