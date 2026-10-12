# WebSockets

A WebSocket route takes the upgrade request through the same middleware as an HTTP route, so a login check or a rate limit that guards your HTTP routes can guard a socket too. Once the chain accepts the upgrade, the package hands the connection to uWebSockets.js, which sends and receives every message in native code.

```ts
import { createApp, serve } from '@delali/uhttp'

const app = createApp().ws('/echo', {
  message: (socket, message) => {
    socket.send(message)
  },
})

const server = await serve({ app, port: 3000 })
```

## Add a WebSocket route

The app and each group have a `ws` method. It takes a path, any middleware and `RouteOptions` for that route alone, and last an object with the handlers and the limits of the route. A path follows the rules of [Routing and middleware](routing.md), and the method throws `INVALID_ROUTE` for a second WebSocket route of the same shape. A WebSocket route has no body, so `ws` throws `INVALID_ROUTE` when its options set `body` or `maxBodyBytes`.

The package calls four handlers, each of which can return a promise:

- `open(socket)` runs once the socket opens.
- `message(socket, message)` runs for each message, with text as a string and a binary message as a `Uint8Array`. The package copies every message before the call, so your handler can await anything before it reads the message.
- `drain(socket)` runs once the client has read enough of a buffer that passed its backpressure limit.
- `close(socket, code, reason)` runs once the socket has closed, for whatever reason. The socket sends nothing from then on, while `socket.data` stays readable.

When `open`, `message`, or `drain` throws or rejects, the package logs the error to the logger of the app with 'A WebSocket handler failed.' and closes the socket with code 1011. When `close` throws, the package logs the error alone.

## Accept or refuse the upgrade in middleware

The package calls the middleware of the app, of each group, and of the route for an upgrade request, as it does for a GET. A middleware can refuse the upgrade with its own reply, such as a 401, and it can await anything first. When the chain ends without such a reply, the package switches protocols with a 101, and it sends any header that a middleware set with `c.header()` on that 101. uWebSockets.js writes `upgrade`, `sec-websocket-accept`, `sec-websocket-protocol`, and `sec-websocket-extensions` itself, so the package leaves out a header of the same name that a middleware set. The 101 names the first subprotocol that the client offered.

Every value that the chain stores with `c.set()` becomes `socket.data`, so the handlers know who the client is without a second lookup:

```ts
const requireLogin: Middleware = {
  headers: ['authorization'],
  handle: async (c, next) => {
    const user = await users.fromToken(c.req.header('authorization'))
    if (user === undefined) return c.json({ error: 'Sign in first.' }, 401)
    c.set('user', user)
    await next()
  },
}

app.ws<{ user: User }>('/chat', requireLogin, {
  open: socket => {
    socket.send(`Welcome, ${socket.data.user.name}.`)
  },
})
```

The `timeoutMs` of the route limits the chain of the upgrade. When the chain passes it, the package sends a 503 and closes the connection.

A plain GET to a WebSocket path receives a 426 with `upgrade: websocket` and `sec-websocket-version: 13`, after the middleware of the path. When you add a GET route on the same path, a plain GET reaches that route. HEAD receives the headers of the 426, and OPTIONS lists `GET, HEAD, OPTIONS`.

## Check the origin

A browser sends an `Origin` header with every upgrade, and the package refuses an upgrade from a page that the route doesn't trust, so that a page on another site can't open a socket with the cookies of your user. By default, the package accepts an origin whose host and port match the `Host` of the request, whatever the scheme. Pass `origins` to accept a fixed list in place of that check:

```ts
app.ws('/chat', { origins: ['https://app.example.com', 'http://localhost:5173'] })
```

The package always refuses the `null` origin, which a sandboxed frame or a local file sends. It accepts an upgrade without an `Origin` header, because a client outside a browser, such as a server or a command-line tool, sends none and carries no cookies of a browser user. Guard such clients with a login check in middleware.

## Handshake errors

When the handshake fails a check, the package throws the error at the end of the chain, in place of the 101, so the middleware of the app, the group, and the route sees the error reply in `c.reply`:

| Code | Status | When the package refuses the upgrade |
| --- | --- | --- |
| `UPGRADE_REQUIRED` | 426 | The client asks for a version of the protocol other than 13. The reply names version 13. |
| `INVALID_UPGRADE` | 400 | The request lacks `upgrade: websocket` or `connection: upgrade`, has a malformed `sec-websocket-key`, or declares a body. After a body, the package closes the connection. |
| `FORBIDDEN_ORIGIN` | 403 | The origin is `null`, or it fails the check of the route. |

uWebSockets.js treats a request as an upgrade only when its `sec-websocket-key` has 24 characters, so the package treats a key of any other length as a plain GET.

## Use the socket

Every handler receives a socket with these members:

- `data` holds the values that the chain stored during the upgrade.
- `send(message, options)` sends a string as text and bytes as a binary message, unless `binary` chooses otherwise. It returns 1 when the socket sent the message, 0 when the message waits in the buffer of the socket, and 2 when the socket dropped the message because its buffer passed the backpressure limit or because the socket has closed.
- `subscribe(topic)` and `unsubscribe(topic)` add the socket to the subscribers of a topic and remove it.
- `publish(topic, message, options)` sends a message to every other subscriber of a topic.
- `end(code, reason)` closes the socket with a close frame. The code is 1000 by default, and it can be any code that RFC 6455 lets a server send, including 3000 to 4999. The reason can take up to 123 bytes of UTF-8.
- `getBufferedAmount()` returns the number of bytes that wait for the client to read.

Each method throws `INVALID_WEBSOCKET` for a topic or a message of the wrong type, and `end` throws it for a code or a reason outside those limits.

## Set the limits of a route

| Option | Default | What it limits |
| --- | --- | --- |
| `maxMessageBytes` | 16 KiB | The longest message from the client. For a longer one, uWebSockets.js drops the connection and the package calls `close` with 1006. |
| `idleTimeoutMs` | 2 minutes | The time without a message before uWebSockets.js closes the socket. It must be from 8 to 960 seconds, and uWebSockets.js rounds it up to the next second. |
| `maxLifetimeMs` | 0, no limit | The time a socket can stay open, rounded up to the next minute, up to 239 minutes. |
| `maxBackpressureBytes` | 64 KiB | The bytes that can wait for a slow client before `send` returns 2. It must be at least 1, because uWebSockets.js reads 0 as no limit. |
| `closeOnBackpressureLimit` | `false` | With `true`, the package closes a socket once it drops a message for backpressure. |
| `compression` | `false` | With `true`, the package offers permessage-deflate with the shared compressor of uWebSockets.js, which keeps no memory per socket. Pass `compress: true` to `send` or `publish` to compress a message. |

The package checks every limit when you add the route, and throws `INVALID_ROUTE` for one outside its range, because uWebSockets.js aborts the process for an idle time or a lifetime outside its range.

uWebSockets.js v20.71.0 accepts a close code from a client from 1000 to 1003, from 1007 to 1011, and from 4000 to 4999, and the package passes such a code to `close` with its reason. For any other code, including the codes from 3000 to 3999 that RFC 6455 registers for libraries, uWebSockets.js drops the connection and the package calls `close` with 1006.

## Publish to a topic

A socket subscribes to a topic, and a message published to the topic reaches every subscriber. A socket that publishes receives none of its own message, while `app.publish()` reaches every subscriber:

```ts
const joinRoom: Middleware = async (c, next) => {
  c.set('room', c.req.param('room'))
  await next()
}

const app = createApp().ws<{ room: string }>('/rooms/:room', joinRoom, {
  open: socket => {
    socket.subscribe(socket.data.room)
  },
  message: (socket, message) => {
    socket.publish(socket.data.room, message)
  },
})

app.publish('lobby', 'The server restarts in five minutes.')
```

`app.publish()` publishes once the app serves, and before `serve()` it does nothing.

With [worker threads](threads.md), a publish on one worker reaches the subscribers on every worker. Each worker tells the others when a topic gains its first subscriber on that worker or loses its last, and a worker forwards a message only to the workers with a subscriber on its topic. That announcement takes time to reach the other workers, so a message that another worker publishes in the gap between `subscribe` and the arrival of the announcement can miss the new subscriber. When a client needs every message, have it fetch what it missed after it subscribes.

## Publish across servers

Pass a pub/sub adapter to `createApp()` to carry each message to the subscribers on other servers, such as through Redis. The adapter has five methods:

- `start(deliver)` runs once on each thread that serves. The adapter calls `deliver(topic, payload)` with each message from another server.
- `subscribe(topic)` runs when a topic gains its first subscriber on a thread.
- `unsubscribe(topic)` runs when a topic loses its last subscriber on a thread.
- `publish(topic, payload)` runs for each message that code on the thread publishes.
- `close()` runs once when the server closes.

The package hands `publish` the message as bytes with a header that marks the format, the type of the message, and the process that published it. Pass those bytes unchanged to `deliver` on every other server. The package drops a message that comes back to the process that published it, because that process has already delivered it to its own subscribers on every worker. It also drops a message that it can't read, with a warning to the logger of the app.

This adapter uses [node-redis](https://github.com/redis/node-redis/blob/master/docs/pub-sub.md):

```ts
import { createClient } from 'redis'
import { createApp, type PubSubAdapter } from '@delali/uhttp'

function redisAdapter(url: string): PubSubAdapter {
  const publisher = createClient({ url })
  const subscriber = publisher.duplicate()
  let deliver: (topic: string, payload: Uint8Array) => void = () => undefined
  return {
    async start(receive) {
      deliver = receive
      await Promise.all([publisher.connect(), subscriber.connect()])
    },
    async subscribe(topic) {
      await subscriber.subscribe(topic, (message, channel) => deliver(String(channel), message), true)
    },
    async unsubscribe(topic) {
      await subscriber.unsubscribe(topic)
    },
    async publish(topic, payload) {
      await publisher.publish(topic, Buffer.from(payload))
    },
    async close() {
      await Promise.all([publisher.close(), subscriber.close()])
    },
  }
}

const app = createApp({ pubsub: redisAdapter('redis://localhost:6379') })
```

When a method of the adapter throws or rejects, the package logs the error to the logger of the app with 'The pub/sub adapter failed.' and keeps delivering to the subscribers on the server. `createApp()` throws `INVALID_APP_OPTIONS` for an adapter that lacks one of the five methods.
