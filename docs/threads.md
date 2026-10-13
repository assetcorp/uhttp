# Worker threads

By default, one Node.js thread serves every request. With `threads`, the main thread receives each connection and passes it to one of several worker threads, each of which builds its own app from a module that you name. Because each worker has its own event loop, the server can use as many CPU cores as you start workers, while your clients connect to one port.

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

The default export of the module should be the app from `createApp()`, or a function that returns the app or a promise of the app. Each worker imports the module once and builds its app from it, while Node.js executes `server.ts` once, on the main thread. Pass the URL of the module, because the main thread can't post an app object to a worker. `serve()` rejects with `INVALID_SERVE_OPTIONS` when you pass `threads` together with an app object or with a Unix socket path, and when you pass `workerHeapMb` or `workerStartTimeoutMs` without `threads`.

`serve()` rejects with `APP_START_FAILED` when the module throws during the first start, or when its default export returns no app. It also rejects with that code when a worker crashes before every worker serves. The `cause` of the error is the error of the worker. Before `serve()` rejects, the package stops the other workers, so the port stays unbound.

With `threads` at 0, which is the default, `serve()` imports the module on the main thread and serves every request there.

## Each worker has its own memory

Every worker executes its own copy of the module, with its own variables, caches, and database connections. A `Map` that one worker fills stays empty on every other worker, so keep shared state, such as sessions or a rate-limit counter, in a database or in a store such as Redis. The package delivers a message that you publish to a WebSocket topic to the subscribers on every worker, as you can read in [WebSockets](websockets.md).

`workerHeapMb` limits the main heap of each worker to that many megabytes, through the `maxOldGenerationSizeMb` resource limit of Node.js:

```ts
await serve({ app: new URL('./app.js', import.meta.url), port: 3000, threads: 4, workerHeapMb: 512 })
```

When a worker passes its heap limit, Node.js stops that worker. If the event loop of that worker has sockets of uWebSockets.js open at that moment, Node.js aborts the whole process with `SIGABRT`. A worker that passes its heap limit while it has open connections therefore ends the process, which closes every connection on every worker. Start the server under a process manager, such as systemd or Kubernetes, that restarts it. Set `workerHeapMb` well above the memory that one worker uses at its busiest, so that a busy worker stays below the limit.

## A worker that crashes

When code on a worker throws an error that no code catches, or a promise rejects without a handler, the worker posts the error to the main thread. The worker then closes its own connections and exits. The main thread logs 'A worker thread crashed.' with the error under `err`, while it goes on passing new connections to the other workers.

The main thread starts a replacement 1 second after the first crash. While the replacements keep failing, the main thread doubles that delay after each one, up to 1 minute. Once a replacement serves for 30 seconds, the main thread resets the delay to 1 second. While no worker serves, the main thread sends a 503 in response to each request.

The server exits with code 1 when a crash leaves no worker that serves or starts, which happens on every crash with `threads: 1`. It also exits with code 1 when workers crash `crashLimit` times within `crashWindowMs`, which is 5 crashes within 10 seconds by default. Before it exits, the main thread closes the port and closes the healthy workers as `server.close()` does, so that their requests in progress can finish within `gracePeriodMs`.

## A worker that hangs

While a worker blocks its thread, for example in a loop without an end, the clients on its connections receive no response. The main thread therefore pings each worker six times within `watchdogMs`, which is 30 seconds by default. It pings a worker from the moment that the worker serves until the worker exits or the server starts to close, including while an old worker finishes its requests after `server.reload()`.

When a worker sends no reply to a ping within `watchdogMs`, the main thread logs 'A worker thread sent no reply to a ping for 30000 ms.' and closes the port. It then closes the healthy workers as `server.close()` does, and it ends the process without waiting for the hung worker. Because the hung worker still has its connections open when Node.js stops it, the process can end with `SIGABRT`.

Start the server under a process manager that restarts it. Raise `watchdogMs` when a route blocks its thread for longer on purpose. Set `watchdogMs` to 0 to switch the watchdog off, in which case the connections of a hung worker stay open until the process ends.

## A worker that takes too long to start

A worker can wait forever while it builds its app, for example when the module waits for a database connection that never opens. The main thread therefore stops a worker that takes longer than `workerStartTimeoutMs` to build its app. The limit is 90 seconds by default, which is the default start timeout of systemd. Raise it when your module loads data for longer than that before it returns the app.

- When a worker of the first start takes too long, `serve()` rejects with `APP_START_FAILED`. The `cause` of that error has the message 'The worker thread took longer than 90000 ms to build its app.'
- When a new worker of `server.reload()` takes too long, the reload rejects with `APP_START_FAILED`, while the old workers go on serving.
- When the replacement for a crashed worker takes too long, the main thread logs 'A worker thread took too long to build its app.' and counts that start as a crash. It then starts another replacement after the delay in [A worker that crashes](#a-worker-that-crashes).

On one thread, the main thread counts those crashes at least `workerStartTimeoutMs` apart. With the default settings, they therefore never reach a `crashLimit` of 5 crashes within 10 seconds on their own, so a module that never builds its app leaves its thread without a worker while the main thread logs each try.

Set `workerStartTimeoutMs` to 0 to let a worker take as long as it needs, in which case `serve()` and `server.reload()` wait until every new worker builds its app.

## Logs

The main thread writes each crash, each hang, and each exit with an error to the `logger` that you pass to `serve()`. That logger has the same `info`, `warn`, and `error` methods as the logger of an app. When you leave it out, the main thread writes to the console. Each worker logs the errors of its requests to the logger of its own app.

## Close the server

`server.close()` closes the port and stops passing connections to the workers. It then sends each worker a message to close its connections in the steps of [Start and stop a server](start-and-stop.md). Each worker lets its requests in progress finish within `gracePeriodMs`, and then it closes every connection that is left and exits.

The watchdog pings no worker during a close, so the promise of `server.close()` resolves once every worker exits, or 5 seconds after the grace period ends, whichever comes first. When a worker is alive at that point, the main thread logs 'A worker thread is alive after the close, so the main thread stops waiting for it.' Node.js can then end the process once your code closes its own resources. Because that worker still has its connections open when Node.js stops it, the process can end with `SIGABRT`.

When your code calls `process.exit()`, the package makes every worker close its connections at once. The main thread then blocks for up to 5 seconds in total until the workers close them, because Node.js aborts a process that exits while a worker has sockets of uWebSockets.js open.
