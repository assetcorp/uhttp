# Responses

A handler returns a reply that a helper on the context builds. Once the whole middleware chain has returned, the package writes that reply to the client. It writes the status, the headers, and the body inside one cork of uWebSockets.js, so that uWebSockets.js sends them to the socket in one write.

```ts
const app = createApp().get('/users/:id', c => c.json({ id: c.req.param('id'), name: 'Ama' }))
```

## Send JSON, text, bytes, or a redirect

Each helper takes the body, an optional status that defaults to 200, and optional headers:

```ts
app.get('/health', c => c.text('ok'))
app.post('/orders', c => c.json({ id: 'ord_42' }, 201, { location: '/orders/ord_42' }))
app.get('/logo.png', c => c.bytes(logoBytes, 200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' }))
app.get('/old-pricing', c => c.redirect('/pricing', 301, { 'cache-control': 'max-age=86400' }))
```

- `c.text()` sends `text/plain; charset=UTF-8`.
- `c.json()` sends `application/json`. It sends `null` for `undefined`.
- `c.bytes()` sends a `Uint8Array` or an `ArrayBuffer` as `application/octet-stream`.
- `c.redirect()` takes the location in place of a body. It sends a `location` header and no body, with 302 unless you pass 301, 303, 307, or 308.

A `content-type` in the headers replaces the helper's content type, so `c.json(problem, 409, { 'content-type': 'application/problem+json' })` sends a problem document. Pass an array for a header that needs several lines, such as `{ 'set-cookie': ['theme=dark', 'lang=en'] }`. A reply can have any status from 200 to 599. For any other status, a helper throws a `UhttpError` with the code `INVALID_STATUS`. For a 204, a 205, or a 304, the package sends no body.

## Set headers from middleware

`c.header()` sets a response header that the package sends with whatever reply the request ends with, including an error reply:

```ts
app.use(async (c, next) => {
  c.header('access-control-allow-origin', 'https://shop.example.com')
  await next()
  c.header('vary', 'Origin', { append: true })
})
```

The package adds a header that a middleware sets before `await next()` to the handler's reply, although the handler's own headers replace a header of the same name. When a middleware sets a header after `await next()`, the package replaces the reply's header of the same name. With `{ append: true }`, the package adds a line and keeps the earlier lines.

One header writer checks every name and value that the package or your code sets. Each name must be an HTTP token. A value must contain no line break, NUL, or other control character apart from a tab, so a value built from user input can never start a second header. `c.header()` and the helpers throw a `UhttpError` with the code `INVALID_HEADER` when a check fails, so the client receives a 500. The package drops `content-length`, `transfer-encoding`, `connection`, and `date` from your headers, because it alone sets the framing of a response.

## Stream a response

`c.stream()` takes a producer that writes the body in chunks. The package sends the headers and calls the producer only after the whole middleware chain has returned, so a middleware can still add headers to the stream. The header writer checks the `contentType` option as it checks any other header:

```ts
app.get('/export.csv', c =>
  c.stream(
    async stream => {
      await stream.write('id,total\n')
      for await (const order of orders.list()) {
        if (!(await stream.write(`${order.id},${order.total}\n`))) return
      }
    },
    { contentType: 'text/csv' },
  ),
)
```

Each `stream.write()` returns a promise that stays pending while the client reads slowly, so the amount of the body in the server's memory stays bounded however slow the client is. The promise resolves to `false` once the client has gone, so your producer can stop at that point. `stream.onClose()` takes a function that the package calls once, when the client goes or the response ends.

Without a length, the package sends a chunked body through `write()` of uWebSockets.js. Whenever the socket is full, it waits for `onWritable` before it writes more. When you pass `{ length }` in bytes, the package sends a `content-length` header and writes through `tryEnd()`. A write that would take the body past the declared length rejects with a `UhttpError` with the code `INVALID_STREAM`. When the producer returns before it has written the declared length, the package logs the same code and closes the connection.

When the producer throws part of the way through, the package logs the error and closes the connection, so that the client can detect the truncated body. For a HEAD request, the package sends the headers, including the declared length where you passed one. It never calls the producer for a HEAD request.

## Send server-sent events

`c.sse()` streams events with the content type `text/event-stream` and `cache-control: no-cache`:

```ts
app.get('/prices', c =>
  c.sse(async events => {
    for await (const price of prices.subscribe()) {
      const sent = await events.send({ event: 'price', id: String(price.sequence), data: JSON.stringify(price) })
      if (!sent) return
    }
  }),
)
```

Each event can have a `data` string, an `event` name, an `id`, and a `retry` time in milliseconds. The helper splits `data` on CR, LF, and CRLF and sends each line as its own `data` field. It throws a `UhttpError` with the code `INVALID_EVENT` for a CR or an LF in an event name, for a CR, an LF, or a NUL in an ID, and for a retry time that is not a whole number of zero or more. Each of those can change how a browser parses the rest of the stream.

The helper sends a heartbeat comment every 30 seconds by default. Under its default [`proxy_read_timeout`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout), nginx closes a proxied connection after 60 seconds without data, and an [AWS Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html#connection-idle-timeout) closes an idle connection after 60 seconds by default. Pass `{ heartbeatMs: 15_000 }` to change the interval, or `{ heartbeatMs: 0 }` to send no heartbeat. The helper stops its heartbeat when the client goes, when the stream ends, and when your producer returns.
