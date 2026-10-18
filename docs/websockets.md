# WebSockets

The package sends the upgrade request of a WebSocket route through the same middleware as an HTTP route, so a login check that you add to your HTTP routes can stop an upgrade with its own reply as well. Once every middleware calls `next()`, the package passes the connection to uWebSockets.js, which frames and parses every message in native code.

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

1. You pass the path first, under the rules of [Routing and middleware](routing.md).
2. You can then pass any middleware and any `RouteOptions` object that apply to this route alone.
3. Last, you pass an object with the handlers and the limits of the route.

`ws` throws `INVALID_ROUTE` when you add a second WebSocket route of the same shape. Because a WebSocket route has no request body, `ws` also throws `INVALID_ROUTE` when you set `body` or `maxBodyBytes` in the options of the route.

The package calls four handlers, each of which can return a promise:

- The package calls `open(socket)` once uWebSockets.js opens the socket.
- The package calls `message(socket, message)` for each message, with text as a string and a binary message as a `Uint8Array`. Because the package copies every message before the call, your handler can await anything and then use the message.
- The package calls `drain(socket)` each time uWebSockets.js sends part of the bytes that are queued on the socket, so that your handler can send more.
- The package calls `close(socket, code, reason)` once the socket closes, whatever the reason. From then on, `send` drops every message, although your code can still use `socket.data`.

When `open`, `message`, or `drain` throws or rejects, the package logs the error to the logger of the app with the message 'A WebSocket handler failed.' and closes the socket with the code 1011. When `close` throws or rejects, the package only logs the error, because the socket is already closed.

## Accept or refuse the upgrade in middleware

The package calls the middleware of the app, of each matching group, and of the route for an upgrade request, as it does for a GET. A middleware can await anything and then end the upgrade with its own reply, such as a 401.

When every middleware calls `next()`, the package sends a 101 and switches the connection to the WebSocket protocol. The package sends every header that a middleware sets with `c.header()` on that 101. uWebSockets.js writes `upgrade`, `sec-websocket-accept`, `sec-websocket-protocol`, and `sec-websocket-extensions` itself, so the package leaves out any header of those names that a middleware sets. When the client sends several subprotocols in `sec-websocket-protocol`, uWebSockets.js selects the first one.

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

For a plain GET to a WebSocket path, the package sends a 426 with the headers `upgrade: websocket` and `sec-websocket-version: 13`, after it calls the middleware of the path. When you add a GET route on the same path, the package sends a plain GET to that route. For HEAD, the package sends the headers of the 426, while for OPTIONS it sends a 204 with `allow: GET, HEAD, OPTIONS`.

## Check the origin

Under [section 10.2 of RFC 6455](https://www.rfc-editor.org/rfc/rfc6455#section-10.2), a server should check the `Origin` header of an upgrade, because a page on another site can open a socket to your server from the browser of your user. That browser can then send the cookies that your server uses to sign the user in. The package therefore sends a 403 for an upgrade from an origin that fails the check of the route.

By default, an origin passes the check when its host and port match the `Host` header of the request, whatever its scheme. To allow a fixed list of origins in place of that check, pass `origins`:

```ts
app.ws('/chat', { origins: ['https://app.example.com', 'http://localhost:5173'] })
```

The `null` origin always fails the check. A browser sends that origin from a sandboxed iframe or from a page on a `file:` URL, among [other cases](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin). An upgrade without an `Origin` header passes the check, because under [section 4.1 of RFC 6455](https://www.rfc-editor.org/rfc/rfc6455#section-4.1), a browser must send one. Such a request can therefore only come from a client outside a browser, which has none of the cookies that the browsers of your users store. Use a login middleware to check those clients.

## Handshake errors

When the handshake fails a check, the package throws the error at the end of the chain in place of the 101, so `c.reply` is the error reply in every middleware of the app, the group, and the route once `await next()` returns:

| Code | Status | When the package sends this error |
| --- | --- | --- |
| `UPGRADE_REQUIRED` | 426 | The client sends a `sec-websocket-version` other than 13. The package sends `sec-websocket-version: 13` with the reply. |
| `INVALID_UPGRADE` | 400 | The request has no `upgrade: websocket` or no `connection: upgrade`, its `sec-websocket-key` is malformed, or it has a `content-length` above 0 or a `transfer-encoding` header. When the request has a body, the package closes the connection after the reply. |
| `FORBIDDEN_ORIGIN` | 403 | The origin is `null`, or the origin fails the check of the route. |

uWebSockets.js handles a request as an upgrade only when its `sec-websocket-key` has 24 characters, so the package handles a request with a key of any other length as a plain GET.

## Use the socket

The package passes every handler a socket with these members:

- `data` is an object with the values that the middleware stores with `c.set()` during the upgrade.
- `send(message, options)` sends a string as text and bytes as a binary message, unless you set `binary`. It returns 1 when uWebSockets.js sends the message at once, while it returns 0 when uWebSockets.js queues the message in the buffer of the socket. It returns 2 when uWebSockets.js drops the message, because the buffer is above the backpressure limit of the route or because the socket is closed.
- `subscribe(topic)` adds the socket to the subscribers of a topic, while `unsubscribe(topic)` removes it.
- `publish(topic, message, options)` sends a message to every other subscriber of a topic.
- `end(code, reason)` closes the socket with a close frame. The code is 1000 by default. You can pass any code that a server may send under RFC 6455, including the codes from 3000 to 4999. The reason can be up to 123 bytes of UTF-8.
- `getBufferedAmount()` returns the number of bytes that are queued for the client.

Each method throws `INVALID_WEBSOCKET` for a topic or a message of the wrong type. `end` also throws it for a code or a reason outside those limits.

## Close and reload the server

`server.close()` closes every socket with the code 1001 and the reason 'The server is going away.' The package then calls the `close` handler of each socket. `server.reload()` closes every socket on the old connections in the same way, so that each client can connect again and receive the renewed certificate.

From the start of a close, the package sends a 503 with the code `SERVER_CLOSING` in response to every new upgrade request. After a reload, the package sends the same 503 for an upgrade request on an old connection. You can read about both methods in [Start and stop a server](start-and-stop.md) and [Serve HTTPS](https.md).

## Set the limits of a route

| Option | Default | What the option limits |
| --- | --- | --- |
| `maxMessageBytes` | 16 KiB | uWebSockets.js drops the connection of a client that sends a longer message. The package then calls `close` with 1006. |
| `idleTimeoutMs` | 2 minutes | uWebSockets.js closes a socket when the client sends nothing for this long. Between 4 and 16 seconds before that point, uWebSockets.js sends a ping, so that the socket of a client that sends a pong for each ping stays open. The value must be from 8 to 960 seconds. The package rounds it up to the next second. |
| `maxLifetimeMs` | 0, which means no limit | uWebSockets.js closes a socket once the socket is open for this long. The package rounds the value up to the next minute. The value can be at most 239 minutes. |
| `maxBackpressureBytes` | 64 KiB | Once the buffer of a socket has more than this many bytes for a slow client, uWebSockets.js drops each message that your code sends, so `send` returns 2. The value must be at least 1, because uWebSockets.js applies no limit for 0. |
| `closeOnBackpressureLimit` | `false` | With `true`, uWebSockets.js closes a socket once it drops a message for backpressure. The package then calls `close` with 1006. |
| `compression` | `false` | With `true`, the package enables permessage-deflate, with one compressor and one decompressor that every socket on the thread uses. Pass `compress: true` to `send` or `publish` to compress a message. |

When you add the route, the package checks every limit and throws `INVALID_ROUTE` for a value outside its range, because uWebSockets.js aborts the process for an idle time or a lifetime outside its range.

When a client closes a socket with a code in the ranges 1000 to 1003, 1007 to 1011, and 4000 to 4999, the package calls `close` with that code and its reason. For any other code, uWebSockets.js v20.71.0 drops the connection, so the package calls `close` with 1006. Those other codes include the range from 3000 to 3999, which is the range for libraries, frameworks, and applications under [section 7.4.2 of RFC 6455](https://www.rfc-editor.org/rfc/rfc6455#section-7.4.2).

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

Because no socket can subscribe before `serve()` starts the app, `app.publish()` drops any message that your code publishes before then.

With [worker threads](threads.md), the package delivers a message that one worker publishes to the subscribers on every worker. Each worker posts a message to the other workers when the first socket on that worker subscribes to a topic, and again when the last one leaves the topic. A worker sends a published message only to the workers that have a subscriber on its topic. Each worker processes those announcements asynchronously. When a worker publishes a message before it processes the announcement of a new subscriber on another worker, the package can therefore fail to deliver that message to the new subscriber. When a client must receive every message, have the client fetch the messages that it missed once it subscribes.

## Publish across servers

Pass a pub/sub adapter to `createApp()` to deliver each message to the subscribers on other servers, for example through Redis. The package calls the five methods of the adapter at these points:

- The package calls `start(deliver)` once on each thread that serves the app. The adapter calls `deliver(topic, payload)` with each message from another server.
- The package calls `subscribe(topic)` when the first socket on a thread subscribes to a topic.
- The package calls `unsubscribe(topic)` when the last socket on a thread unsubscribes from a topic or closes.
- The package calls `publish(topic, payload)` for each message that code on the thread publishes.
- The package calls `close()` once on each thread when the server closes.

The package passes `publish` the message as bytes, after a header with the version of the format, the type of the message, and an ID of the process that publishes it. Pass those bytes unchanged to `deliver` on every other server. The package drops a message from its own process, because that process already delivers the message to its own subscribers on every worker. It also drops a message that it fails to parse, together with a warning that it logs to the logger of the app.

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
