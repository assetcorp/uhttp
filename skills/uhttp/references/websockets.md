# WebSockets and pub/sub

`app.ws(path, ...middleware, route)` adds a WebSocket route. uhttp sends the upgrade request through the middleware of the app, of each matching group, and of the route, as it does a GET, so a login check can refuse an upgrade with its own reply. Every value that a middleware stores with `c.set()` during the upgrade becomes part of `socket.data`, and the type argument of `ws` gives that data its type.

```ts
import { createApp, type Middleware, serve } from '@delali/uhttp'

interface Member {
  name: string
}

const membersByToken = new Map<string, Member>([['token-support', { name: 'Support agent' }]])

const joinRoom: Middleware = {
  before: c => {
    const token = new URLSearchParams(c.req.query).get('token')
    const member = token === null ? undefined : membersByToken.get(token)
    if (member === undefined) return c.json({ error: 'Sign in first.' }, 401)
    c.set('member', member)
    c.set('room', c.req.param('room'))
  },
}

const app = createApp({ logger: console })

app.ws<{ member: Member; room: string }>('/rooms/:room', joinRoom, {
  origins: ['https://chat.example.com', 'http://localhost:5173'],
  maxMessageBytes: 4 * 1024,
  open: socket => {
    socket.subscribe(socket.data.room)
    socket.send(`Welcome to ${socket.data.room}, ${socket.data.member.name}.`)
  },
  message: (socket, message) => {
    if (typeof message !== 'string') return socket.end(1003, 'Send text messages.')
    socket.publish(socket.data.room, `${socket.data.member.name}: ${message}`)
  },
  close: socket => {
    app.publish(socket.data.room, `${socket.data.member.name} left.`)
  },
})

await serve({ app, port: 3000 })
```

Check the route from Node.js with the global `WebSocket`:

```ts
const socket = new WebSocket('ws://127.0.0.1:3000/rooms/support?token=token-support')
const welcome = await new Promise(resolve => socket.addEventListener('message', event => resolve(event.data), { once: true }))
console.log(welcome)
socket.close()
```

## Handlers and the socket

- uhttp calls `open(socket)` once the socket opens, `message(socket, message)` for each message, `drain(socket)` when uWebSockets.js has sent part of the queued bytes, and `close(socket, code, reason)` once the socket closes. A text message arrives as a string, and a binary message as a `Uint8Array` that the handler can keep after an `await`.
- When `open`, `message`, or `drain` throws or rejects, uhttp logs the error and closes the socket with the code 1011.
- `socket.send(message)` returns 1 when uWebSockets.js sends the message at once, 0 when it queues the message, and 2 when it drops the message, because the queue holds more than `maxBackpressureBytes` or the socket is closed.
- `socket.end(code, reason)` closes the socket with a close frame, with the code 1000 by default and a reason of up to 123 bytes.
- The `WebSocket` API of a browser can set no `Authorization` header on an upgrade, so take a token from the query string or from a cookie, as `joinRoom` does with the query string.

## The origin check

A page on another site can open a socket to the server from the browser of a signed-in user, and that browser then sends the cookies of the user with the upgrade. uhttp therefore answers 403 to an upgrade whose `Origin` fails the check of the route:

| `origins` | uhttp accepts an upgrade from |
| --- | --- |
| Left out | An `http` or `https` origin whose host and port match the `Host` header |
| A list | Each origin in the list |
| A function `(origin, c) => boolean` | Each origin for which the function returns `true` or a promise of `true` |
| `'*'` | Every origin, including `null` |

- List the origin of a dev server, such as `http://localhost:5173` for Vite, when the page and the server use different ports.
- Use `'*'` only when every client signs in with a credential that its code adds, such as a token in the query string, because a cookie, the credentials of HTTP authentication, and a client certificate reach the server from any page under `'*'`.
- uhttp accepts an upgrade without an `Origin` header under every check, because a browser always sends one, so check clients outside a browser with a login middleware.

## Limits of a route

uhttp checks each limit when you add the route, and it throws `INVALID_ROUTE` for a value outside its range:

| Option | Default | What happens past the limit |
| --- | --- | --- |
| `maxMessageBytes` | 16 KiB | uWebSockets.js drops the connection, and uhttp calls `close` with 1006. |
| `idleTimeoutMs` | 2 minutes, from 8 to 960 seconds | uWebSockets.js closes a socket on which the client sends nothing, after it sends a ping that a client can answer with a pong. |
| `maxLifetimeMs` | 0, which means no limit, and 239 minutes at most | uWebSockets.js closes the socket. |
| `maxBackpressureBytes` | 64 KiB | `send` returns 2 and drops each message while the queue is above the limit. |
| `closeOnBackpressureLimit` | `false` | With `true`, uWebSockets.js closes the socket once it drops a message. |
| `compression` | `false` | With `true`, a message that you send with `compress: true` goes out compressed with permessage-deflate. |

## Topics across threads and servers

- `socket.subscribe(topic)` adds a socket to a topic. `socket.publish(topic, message)` sends the message to every other subscriber, while `app.publish(topic, message)` sends it to every subscriber.
- `app.publish()` drops every message that code publishes before `serve()` starts the app.
- With [worker threads](threads.md), uhttp delivers each message to the subscribers on every worker. A message that one worker publishes while another worker is adding a new subscriber can miss that subscriber, so have a client that must receive every message fetch what it missed once it subscribes.
- To reach the subscribers on other servers, pass `createApp()` a `pubsub` adapter with the methods `start(deliver)`, `subscribe(topic)`, `unsubscribe(topic)`, `publish(topic, payload)`, and `close()`, such as one on Redis. The adapter passes each payload unchanged to `deliver` on every other server. Take the details from the TSDoc of `PubSubAdapter` in the installed types.
- `server.close()` closes every socket with the code 1001. A plain GET to a WebSocket path receives a 426, unless the app has a GET route on the same path.
