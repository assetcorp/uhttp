# Start and stop a server

`serve()` starts a server on a port or on a Unix socket, while `server.close()` waits for each request in progress, up to a grace period, before it stops that server. The package installs no signal handler, so you can call `server.close()` from a handler of your own, such as one for `SIGTERM`.

```ts
import { createApp, serve } from '@delali/uhttp'

const app = createApp().get('/health', c => c.text('ok'))
const server = await serve({ app, port: 3000 })
```

## Listen on a port

Pass `port`, together with `host` when you want the server to listen on one address alone, such as `127.0.0.1`. When you leave `host` out, the server listens on every interface. With port 0, the operating system assigns a free port, which you can read from `server.port` once `serve()` resolves:

```ts
const server = await serve({ app, port: 0, host: '127.0.0.1' })
console.log(`The server listens on port ${server.port}.`)
```

The server binds its port exclusively, so `serve()` rejects with `LISTEN_FAILED` when another server already listens on that port. To start several processes on one port, set `reusePort` on each of them, so that the operating system lets them share it. However, a server that sets `reusePort` fails to bind a port to which a server without `reusePort` is bound, since the operating system shares a port only between servers that both set the option. `serve()` rejects with `INVALID_SERVE_OPTIONS` when you pass `reusePort` with port 0 or with a Unix socket path.

## Listen on a Unix socket

Pass `path` in place of `port` and `host` to listen on a Unix socket, which a reverse proxy on the same machine can connect to. Before it binds the path, the package removes a socket file on which no server listens. `serve()` rejects with `LISTEN_FAILED` when the file at the path is not a socket, or when a server listens on that socket.

Once the server listens, the package sets the mode of the socket file to `0o600`, so that only the user who owns the process can connect. Set `socketMode` to let more users connect, such as `0o660` for the group of the process:

```ts
const server = await serve({ app, path: '/run/shop/http.sock', socketMode: 0o660 })
```

Between the bind and that change of mode, the file has the mode that the umask of the process allows. To let only your own user connect during that gap, set a strict umask such as `077`. `server.close()` removes the socket file.

## Close the server

`server.close()` first closes the listening socket, so a client that tries to connect to the port from then on gets the error `ECONNREFUSED`. On each thread, the server then does the following at the same time:

- It closes every WebSocket with the code 1001.
- It waits until each request in progress finishes, and then it sends the reply with `Connection: close` and closes that connection.
- It sends a 503 with the code `SERVER_CLOSING` and `Connection: close` in response to every new request on an open connection. The package calls no middleware for such a request.
- Once no request is in progress on the thread, it closes every connection on the thread, which includes each idle keep-alive connection.

Once `gracePeriodMs` passes, which is 10 seconds by default, the server closes every connection that is left, including a connection whose request is still in progress. The promise from `server.close()` resolves once every connection closes. A second call returns that same promise, so you can call `server.close()` from more than one place. With worker threads, the promise resolves once each worker exits, after every worker takes the same steps.

uWebSockets.js v20.71.0 gives the package no way to reach a connection between two requests, so the package closes the idle connections of a thread together, once the last request on that thread finishes or once `gracePeriodMs` passes. Until then, an idle connection stays open, so a client that sends a request on it receives the 503.

## Close the server on a signal

The package installs no handler for `SIGTERM` or `SIGINT`, because your app may have to close resources of its own after the server, such as a database pool:

```ts
import { createApp, serve } from '@delali/uhttp'
import pg from 'pg'

const pool = new pg.Pool()
const app = createApp().get('/health', c => c.text('ok'))
const server = await serve({ app, port: 3000, gracePeriodMs: 20_000 })

async function shutDown() {
  await server.close()
  await pool.end()
}

process.once('SIGTERM', shutDown)
process.once('SIGINT', shutDown)
```

Node.js ends the process once its event loop has no open handle left, so close every timer and every pool that your code opens as well. Set `gracePeriodMs` below the time that your process manager waits between its stop signal and `SIGKILL`, so that the server can close its connections before the process manager kills the process.

## Exit with process.exit()

When your code calls `process.exit()` on a server with worker threads, the exit hook of the package posts a message that makes every worker close its connections at once. The main thread then blocks for up to 5 seconds in total until each worker closes its connections, because Node.js aborts a process that exits while a worker has sockets of uWebSockets.js open. Those connections close without the steps of `server.close()`, so call `server.close()` first when you need a request in progress to finish. The exit hook skips every worker that the main thread marks as hung, as you can read in [Worker threads](threads.md).
