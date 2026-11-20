# Worker threads

With the `threads` option, `serve()` starts that many worker threads behind one port. The main thread accepts each connection and passes it to a worker, and each worker imports the app module and builds a separate app from its default export, which is an app or a function that returns an app or a promise of one.

`server.ts` starts one worker for each CPU core:

```ts
import { availableParallelism } from 'node:os'
import { serve } from '@delali/uhttp'

const server = await serve({ app: new URL('./app.ts', import.meta.url), port: 3000, threads: availableParallelism() })

async function shutDown() {
  await server.close()
}

process.once('SIGTERM', shutDown)
process.once('SIGINT', shutDown)
```

`app.ts` builds the app on each worker:

```ts
import { threadId } from 'node:worker_threads'
import { createApp } from '@delali/uhttp'

export default () => createApp({ logger: console }).get('/hello', c => c.text(`Hello from worker ${threadId}.`))
```

- Pass the URL of a module that Node.js can import as it executes: `./app.ts` when Node.js executes the TypeScript files, as `node server.ts` does on Node.js 24, or `./app.js` beside the compiled server when the project compiles TypeScript first.
- `serve()` rejects with `INVALID_SERVE_OPTIONS` when you pass `threads` together with an app object or a Unix socket `path`, and with `APP_START_FAILED` when the module throws or exports no app. The `cause` of that error holds the error of the worker.
- Each worker has separate memory, so a `Map` that one worker fills stays empty on the others. Keep sessions, caches that every worker must agree on, and counters in a database or in a store such as Redis.
- The built-in store of `rateLimit()` shares its counts between workers, as long as every worker builds the same rate limiters in the same order when it loads the module.
- uhttp delivers each message that code publishes to a WebSocket topic to the subscribers on every worker.
- Pass `logger` to `serve()` for the messages of the main thread, which writes to the console without one. Each worker logs the errors of its requests to the logger of its app.

## Crashes and hangs

Start the server under a process manager that restarts it, such as systemd or Kubernetes, because uhttp ends the process in the cases below.

- When a worker crashes, the main thread logs 'A worker thread crashed.' and starts a replacement after 1 second, doubling that delay after each failed replacement up to 1 minute. While no worker serves, the main thread answers each request with a 503.
- The process exits with code 1 when workers crash `crashLimit` times within `crashWindowMs`, which is 5 crashes within 10 seconds by default, and when a crash leaves no worker, as every crash does with `threads: 1`.
- When a worker sends no reply to the pings of the main thread for `watchdogMs`, which is 30 seconds by default, the main thread closes the port and ends the process. Raise `watchdogMs` for a route that blocks its thread for longer on purpose.
- `workerStartTimeoutMs`, which is 90 seconds by default, limits how long a worker can take to build its app.
- `workerHeapMb` limits the heap of each worker. A worker that passes it while it holds open connections ends the whole process, so set it well above the memory that one worker uses at its busiest.
- `server.close()` closes the port, lets each worker finish its requests within `gracePeriodMs`, and resolves once every worker exits.
