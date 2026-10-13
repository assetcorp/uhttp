# WebSockets

The package sends the upgrade request of a WebSocket route through the same middleware as an HTTP route, so a login check that you add to your HTTP routes can refuse an upgrade as well. When no middleware refuses the upgrade, the package passes the connection to uWebSockets.js, which frames and parses every message in native code.

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

The app and each group have a `ws` method, which takes its arguments in this order:

1. You pass the path first, and the path follows the rules of [Routing and middleware](routing.md).
2. You can then pass any middleware and any `RouteOptions` object that apply to this route alone.
3. You pass an object with the handlers and the limits of the route last.

`ws` throws `INVALID_ROUTE` when you add a second WebSocket route of the same shape. Because the package reads no body for a WebSocket route, `ws` also throws `INVALID_ROUTE` when the options of the route set `body` or `maxBodyBytes`.

The package calls four handlers, and each of them can return a promise:

- The package calls `open(socket)` once uWebSockets.js has opened the socket.
- The package calls `message(socket, message)` for each message, with text as a string and a binary message as a `Uint8Array`. Because the package copies every message before the call, your handler can await anything and then use the message.
- The package calls `drain(socket)` each time uWebSockets.js has sent part of the bytes that were queued on the socket, so that your handler can send more.
- The package calls `close(socket, code, reason)` once the socket has closed for any reason. From then on, `send` drops every message, although your code can still use `socket.data`.

When `open`, `message`, or `drain` throws or rejects, the package logs the error to the logger of the app with the message 'A WebSocket handler failed.' and closes the socket with the code 1011. When `close` throws or rejects, the package only logs the error, because the socket has already closed.

## Accept or refuse the upgrade in middleware

The package calls the middleware of the app, of each matching group, and of the route for an upgrade request, as it does for a GET. A middleware can await anything and then refuse the upgrade with its own reply, such as a 401.

When every middleware calls `next()`, the package answers with a 101 and switches the connection to the WebSocket protocol. The package sends every header that a middleware set with `c.header()` on that 101. uWebSockets.js writes `upgrade`, `sec-websocket-accept`, `sec-websocket-protocol`, and `sec-websocket-extensions` itself, so the package leaves out any header of those names that a middleware set. When the client offers several subprotocols, uWebSockets.js accepts the first one.

Every value that a middleware stores with `c.set()` during the upgrade becomes part of `socket.data`, so your handlers can use the signed-in user without a second lookup:

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

The `timeoutMs` of the route limits how long the middleware can take over an upgrade. When the middleware takes longer, the package sends a 503 and closes the connection.

The package answers a plain GET to a WebSocket path with a 426 and the headers `upgrade: websocket` and `sec-websocket-version: 13`, after it calls the middleware of the path. When you add a GET route on the same path, the package sends a plain GET to that route. The package answers HEAD with the headers of the 426, while it answers OPTIONS with a 204 and `allow: GET, HEAD, OPTIONS`.

## Check the origin

[RFC 6455](https://www.rfc-editor.org/rfc/rfc6455#section-10.2) tells a server to check the `Origin` header of an upgrade, because a page on another site can open a socket to your server from the browser of your user. That browser can then send the cookies that your server uses to sign the user in. The package therefore refuses an upgrade from an origin that the route doesn't trust.

By default, the package accepts an origin whose host and port match the `Host` header of the request, whatever its scheme. To accept a fixed list of origins in place of that check, pass `origins`:

```ts
app.ws('/chat', { origins: ['https://app.example.com', 'http://localhost:5173'] })
```

The package always refuses the `null` origin, which a browser sends from a sandboxed iframe or from a page on a `file:` URL, among [other cases](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin). The package accepts an upgrade that has no `Origin` header, because [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455#section-4.1) requires a browser to send one. Such a request can therefore only come from a client outside a browser, which has none of the cookies that the browsers of your users store. Use a login middleware to check those clients.

## Handshake errors

When the handshake fails a check, the package throws the error at the end of the chain in place of the 101, so `c.reply` is the error reply in every middleware of the app, the group, and the route once `await next()` returns:

| Code | Status | When the package refuses the upgrade |
| --- | --- | --- |
| `UPGRADE_REQUIRED` | 426 | The client asks for a version of the protocol other than 13. The package sends `sec-websocket-version: 13` with the reply. |
| `INVALID_UPGRADE` | 400 | The request has no `upgrade: websocket` or no `connection: upgrade`, its `sec-websocket-key` is malformed, or it has a `content-length` above 0 or a `transfer-encoding` header. When the request has a body, the package closes the connection after the reply. |
| `FORBIDDEN_ORIGIN` | 403 | The origin is `null`, or the origin fails the check of the route. |

uWebSockets.js treats a request as an upgrade only when its `sec-websocket-key` has 24 characters, so the package answers a request with a key of any other length as a plain GET.

## Use the socket

The package passes every handler a socket with these members:

- `data` is an object with the values that the middleware stored during the upgrade.
- `send(message, options)` sends a string as text and bytes as a binary message, unless you set `binary`. It returns 1 when uWebSockets.js has sent the message and 0 when uWebSockets.js has queued the message in the buffer of the socket. It returns 2 when uWebSockets.js has dropped the message, because the buffer has passed the backpressure limit of the route or because the socket has closed.
- `subscribe(topic)` adds the socket to the subscribers of a topic, while `unsubscribe(topic)` removes it.
- `publish(topic, message, options)` sends a message to every other subscriber of a topic.
- `end(code, reason)` closes the socket with a close frame. The code is 1000 by default, and you can pass any code that RFC 6455 lets a server send, including the codes from 3000 to 4999. The reason can be up to 123 bytes of UTF-8.
- `getBufferedAmount()` returns the number of bytes that are queued for the client.

Each method throws `INVALID_WEBSOCKET` for a topic or a message of the wrong type. `end` also throws it for a code or a reason outside those limits.

## Set the limits of a route

| Option | Default | What the option limits |
| --- | --- | --- |
| `maxMessageBytes` | 16 KiB | uWebSockets.js drops the connection of a client that sends a longer message, and the package then calls `close` with 1006. |
| `idleTimeoutMs` | 2 minutes | uWebSockets.js closes a socket when the client sends nothing for this long. Between 4 and 16 seconds before that point, uWebSockets.js sends a ping, so that a client which answers pings keeps the socket open. The value must be from 8 to 960 seconds, and the package rounds it up to the next second. |
| `maxLifetimeMs` | 0, which means no limit | uWebSockets.js closes a socket once the socket has been open for this long. The package rounds the value up to the next minute, and the value can be at most 239 minutes. |
| `maxBackpressureBytes` | 64 KiB | Once the buffer of a socket has more than this many bytes for a slow client, uWebSockets.js drops each message that your code sends, and `send` returns 2. The value must be at least 1, because uWebSockets.js treats 0 as no limit. |
| `closeOnBackpressureLimit` | `false` | With `true`, uWebSockets.js closes a socket once it drops a message for backpressure, and the package then calls `close` with 1006. |
| `compression` | `false` | With `true`, the package offers permessage-deflate with one compressor and one decompressor that every socket on the thread shares. Pass `compress: true` to `send` or `publish` to compress a message. |

The package checks every limit when you add the route, and it throws `INVALID_ROUTE` for a value outside its range, because uWebSockets.js aborts the process for an idle time or a lifetime outside its range.

uWebSockets.js v20.71.0 accepts a close code from a client in the ranges 1000 to 1003, 1007 to 1011, and 4000 to 4999, and the package passes such a code to `close` together with its reason. For any other code, including the codes from 3000 to 3999 that [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455#section-7.4.2) reserves for libraries, frameworks, and applications, uWebSockets.js drops the connection, and the package calls `close` with 1006.

## Publish to a topic

When a socket subscribes to a topic, the package delivers to that socket every message that your code publishes on the topic. `socket.publish()` leaves out the socket that publishes, while `app.publish()` delivers to every subscriber:

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

Because no socket can subscribe before `serve()` has started the app, `app.publish()` drops any message that your code publishes before then.

With [worker threads](threads.md), the package delivers a message that one worker publishes to the subscribers on every worker. Each worker posts a message to the other workers when the first socket on that worker subscribes to a topic, and again when the last one leaves the topic. A worker sends a published message only to the workers that have a subscriber on its topic. The other workers process each of those announcements asynchronously, so the package can fail to deliver a message to the new subscriber when another worker publishes the message before it has processed the announcement. When a client needs every message, make it fetch the messages that it lost once it has subscribed.

## Publish across servers

Pass a pub/sub adapter to `createApp()` to deliver each message to the subscribers on other servers, for example through Redis. The package calls the five methods of the adapter at these points:

- The package calls `start(deliver)` once on each thread that serves the app. The adapter calls `deliver(topic, payload)` with each message from another server.
- The package calls `subscribe(topic)` when the first socket on a thread subscribes to a topic.
- The package calls `unsubscribe(topic)` when the last socket on a thread unsubscribes from a topic or closes.
- The package calls `publish(topic, payload)` for each message that code on the thread publishes.
- The package calls `close()` once on each thread when the server closes.

The package passes `publish` the message as bytes, after a header with the version of the format, the type of the message, and an ID of the process that published it. Pass those bytes unchanged to `deliver` on every other server. The package drops a message that the same process published, because that process has already delivered the message to its own subscribers on every worker. It also drops a message that it can't parse, and it logs a warning to the logger of the app.

The adapter below uses [node-redis](https://github.com/redis/node-redis/blob/master/docs/pub-sub.md):

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

When a method of the adapter throws or rejects, the package logs the error to the logger of the app with the message 'The pub/sub adapter failed.' and goes on delivering to the subscribers on the server. `createApp()` throws `INVALID_APP_OPTIONS` for an adapter without one of the five methods.
