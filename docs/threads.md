# Worker threads

By default, one Node.js thread serves every request. With `threads`, the main thread accepts each connection and passes it to one of several worker threads, each of which builds its own app from a module that you name. Because each worker has its own event loop, the server can use as many CPU cores as you start workers, while your clients connect to one port.

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

The default export of the module should be the app from `createApp()`, or a function that returns the app or a promise of the app. Each worker imports the module once and builds its app from it, while Node.js executes `server.ts` once, on the main thread. Pass the URL of the module, because the main thread can't post an app object to a worker. `serve()` throws `INVALID_SERVE_OPTIONS` when you pass `threads` together with an app object or with a Unix socket path, and when you pass `workerHeapMb` without `threads`.

`serve()` rejects with `APP_START_FAILED` when the module throws during the first start, or when its default export returns no app. It also rejects with that code when a worker crashes before every worker serves. The `cause` of the error is the error of the worker, and the package stops the other workers before it rejects, so the port stays unbound.

With `threads` at 0, which is the default, `serve()` imports the module on the main thread and serves every request there.

## Each worker has its own memory

Every worker executes its own copy of the module, with its own variables, caches, and database connections. A `Map` that one worker fills stays empty on every other worker, so keep shared state, such as sessions or a rate-limit counter, in a database or in a store such as Redis. The package delivers a WebSocket publish to the subscribers on every worker, as you can read in [WebSockets](websockets.md).

`workerHeapMb` limits the main heap of each worker to that many megabytes, through the `maxOldGenerationSizeMb` resource limit of Node.js:

```ts
await serve({ app: new URL('./app.js', import.meta.url), port: 3000, threads: 4, workerHeapMb: 512 })
```

Node.js stops a worker that passes its heap limit, and it aborts the whole process with `SIGABRT` when the event loop of that worker still has sockets of uWebSockets.js open. A worker that passes its heap limit while it has open connections therefore ends the process, and every connection on every worker closes with it. Start the server under a process manager, such as systemd or Kubernetes, that restarts it. Set `workerHeapMb` well above the memory that one worker needs, so that a busy worker stays below the limit.

## A worker that crashes

When code on a worker throws an error that no code catches, or a promise rejects without a handler, the worker posts the error to the main thread. The worker then closes its own connections and exits. The main thread logs 'A worker thread crashed.' with the error under `err`, and it goes on passing new connections to the other workers.

The main thread starts a replacement 1 second after the first crash. While the replacements keep failing, the main thread doubles that delay after each one, up to 1 minute. Once a replacement has served for 30 seconds, the main thread resets the delay to 1 second. While no worker serves, the main thread answers each request with a 503.

The server exits with code 1 when a crash leaves no worker that serves or starts, which happens on every crash with `threads: 1`. It also exits with code 1 when workers crash `crashLimit` times within `crashWindowMs`, which is 5 crashes within 10 seconds by default. Before it exits, the main thread closes the port and gives the healthy workers up to 5 seconds in total to close their connections.

## A worker that hangs

A worker that blocks its thread, for example in a loop without an end, answers no request on its connections until the block ends. The main thread therefore pings each serving worker six times within `watchdogMs`, which is 30 seconds by default. When a worker fails to reply for that long, the main thread logs 'A worker thread failed to answer for 30000 ms.' and closes the port. It then ends the process. Because the hung worker can still have open connections when Node.js stops it, the process can end with `SIGABRT`.

Start the server under a process manager that restarts it. Raise `watchdogMs` when a route blocks its thread for longer on purpose. Set `watchdogMs` to 0 to switch the watchdog off, in which case a hung worker keeps its connections until the process ends.

## Logs

The main thread writes each crash, each hang, and each exit with an error to the `logger` that you pass to `serve()`. That logger has the same `info`, `warn`, and `error` methods as the logger of an app. When you leave it out, the main thread writes to the console. Each worker logs the errors of its requests to the logger of its own app.

## Close the server

`server.close()` closes the port and then posts a message to each worker to leave. Each worker first posts a reply to the main thread, which then stops passing connections to that worker. The worker then closes its connections and exits. The promise resolves once every worker has exited, so it stays pending while a worker hangs with the watchdog switched off.
