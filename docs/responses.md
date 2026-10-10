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
- `c.json()` sends `application/json`, with `null` in place of `undefined`.
- `c.bytes()` sends a `Uint8Array` or an `ArrayBuffer` as `application/octet-stream`.
- `c.redirect()` takes the location in place of a body. It sends a `location` header with an empty body and the status 302, unless you pass 301, 303, 307, or 308.

A `content-type` in the headers replaces the helper's content type, so `c.json(problem, 409, { 'content-type': 'application/problem+json' })` sends a problem document. Pass an array for a header that needs several lines, such as `{ 'set-cookie': ['theme=dark', 'lang=en'] }`. A reply can have any status from 200 to 599. For any other status, a helper throws a `UhttpError` with the code `INVALID_STATUS`. For a 204, a 205, or a 304, the package sends the status and the headers alone.

## Set headers from middleware

`c.header()` sets a response header that the package sends with whatever reply the request ends with, including an error reply:

```ts
app.use(async (c, next) => {
  c.header('access-control-allow-origin', 'https://shop.example.com')
  await next()
  c.header('vary', 'Origin', { append: true })
})
```

For each header name, the package sends the value that your code or the reply set last. The package therefore sends a header that a middleware sets before `await next()` with the handler's reply, unless the handler's reply sets a header of the same name. When a middleware sets a header after `await next()`, the package sends that value in place of the reply's header of the same name. With `{ append: true }`, the package adds a line after the earlier lines, including the lines of the reply.

When a later reply replaces a reply, as an error reply does after a throw, the package sends the headers of the later reply together with the headers that your code set with `c.header()`. The package therefore sends a `location`, a `set-cookie`, or a `cache-control` from the handler's reply only when it sends that reply.

One header writer checks every name and value that the package or your code sets. Each name has to be an HTTP token. Each value can contain a tab and any printable character. For a line break, a NUL, or any other control character, the writer throws, so the package writes every value, including a value built from user input, on one header line. `c.header()` and the helpers throw a `UhttpError` with the code `INVALID_HEADER` when a check fails, so the package sends a 500. The package drops `content-length`, `transfer-encoding`, `connection`, and `date` from your headers, because it sets the framing of a response itself.

## Stream a response

`c.stream()` takes a producer that writes the body in chunks. The package sends the headers and calls the producer after the whole middleware chain has returned, so a middleware can still add headers to the stream. The header writer checks the `contentType` option as it checks any other header:

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

Each `stream.write()` returns a promise that stays pending while the client reads slowly, so the package buffers a bounded part of the body however slow the client is. The promise resolves to `false` once the client has gone, so your producer can stop at that point. `stream.onClose()` takes a function that the package calls once, when the client goes or the response ends.

Without a length, the package sends a chunked body through `write()` of uWebSockets.js. Whenever the socket is full, the package waits for `onWritable` before it writes more. When you pass `{ length }` in bytes, the package sends a `content-length` header and writes through `tryEnd()`. A write that would take the body past the declared length rejects with a `UhttpError` with the code `INVALID_STREAM`. When the producer returns before it has written the declared length, the package logs the same code and closes the connection.

When the producer throws part of the way through, the package logs the error and closes the connection, so that the client can detect the truncated body. For a HEAD request, the package sends the headers alone, including the declared length where you passed one, and it calls the producer for the other methods only.

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

Each event can have a `data` string, an `event` name, an `id`, and a `retry` time in milliseconds. The helper splits `data` on CR, LF, and CRLF, and it sends each line as its own `data` field. A stray CR, LF, or NUL in another field can change how a browser parses the rest of the stream, so the helper throws a `UhttpError` with the code `INVALID_EVENT` for an event that breaks one of these rules:

- An event name has to be free of CR and LF.
- An ID has to be free of CR, LF, and NUL.
- A retry time has to be a whole number of zero or more.

The helper sends a heartbeat comment every 30 seconds by default. Under its default [`proxy_read_timeout`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout), nginx closes a proxied connection after 60 seconds without data, and an [AWS Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html#connection-idle-timeout) closes an idle connection after 60 seconds by default. Pass `{ heartbeatMs: 15_000 }` to change the interval, or `{ heartbeatMs: 0 }` to switch the heartbeat off. The helper stops its heartbeat when the client goes, when the stream ends, and when your producer returns.
