# Request bodies and validation

A handler reads the body of a request through `c.req.body`, either as a stream of byte chunks or through a parser for JSON, text, bytes, or a URL-encoded form. `json(schema)` checks the parsed body against a schema from any validator that implements [Standard Schema](https://standardschema.dev), such as Valibot, Zod, or ArkType. The package depends on none of those validators, so you can keep the one that your project already uses. On every read, the package enforces the body limit of the route, which is 1 MiB unless you set another.

```ts
import { createApp } from '@delali/uhttp'
import * as v from 'valibot'

const NewUser = v.object({ name: v.string(), email: v.pipe(v.string(), v.email()) })

const app = createApp().post('/users', async c => {
  const user = await c.req.body.json(NewUser)
  return c.json({ created: user.name }, 201)
})
```

For uploads from a `multipart/form-data` form, read [Uploads](uploads.md).

## The routes that read a body

The package attaches a body reader to every POST, PUT, and PATCH route. On a route of any other method, it attaches a reader only when you ask for one, because the package does more work on every request of a route with a reader, even on a request without a body. Set `body: true` in the options of a route to read the body of a DELETE or a GET request, and set `body: false` to leave the reader off a POST route that ignores its body:

```ts
app.delete('/sessions', { body: true }, async c => {
  const { ids } = (await c.req.body.json()) as { ids: string[] }
  return c.json({ revoked: ids.length })
})
```

When code on a route without a reader calls a method of `c.req.body`, the method throws a `UhttpError` with the code `UNDECLARED_BODY`. The message of that error contains the name of the `body` option, so that you can see which option to set when the first test of that route fails.

uWebSockets.js can drop the bytes of a body that arrive before a reader exists, so the package attaches the reader inside the synchronous handler of uWebSockets.js, straight after it copies the request. The package then queues the chunks until your code reads them, so a middleware can await a database or a remote service before the handler reads the body.

## Parse JSON, text, bytes, and forms

Every parser apart from `bytes()` checks the `Content-Type` of the request before it reads any of the body. When the request has a type outside the list below, the parser throws a `UhttpError` with the code `UNSUPPORTED_MEDIA_TYPE`, which the client receives as a 415.

| Method | Content types that it accepts | What it returns |
| --- | --- | --- |
| `json()` | `application/json` and any `application/*+json`, in UTF-8 | The parsed value |
| `json(schema)` | The same as `json()` | The output of the schema |
| `text()` | Any `text/*`, decoded in its `charset`, which is UTF-8 when the request names none | A string |
| `bytes()` | Any type | A `Uint8Array` |
| `form()` | `application/x-www-form-urlencoded` | A flat map of names and values |

When `json()` can't parse the body, it throws a `UhttpError` with the code `INVALID_JSON`, which the client receives as a 400. It throws the same error for a body with a `__proto__` key at any depth, or with a `constructor` key whose value has a `prototype` key, because code that merges such an object recursively into another object can add properties to `Object.prototype`, which every object in the process inherits.

`form()` parses a URL-encoded body into a map with no bracket or dot nesting, so the map holds `user[name]=Ama` under the name `user[name]`. For a name that the form repeats, such as a group of checkboxes, the map holds a list of the values. The map has no prototype, so a field named `__proto__` is an ordinary entry. `form()` counts the parameters while it parses them and throws `PAYLOAD_TOO_LARGE` as soon as a body passes 1,000 of them, which the client receives as a 413.

After a parser reads the body, the package keeps its bytes, so you can call any parser again, or call `stream()`, which then yields those bytes as one chunk. However, once your code streams a body that no parser has read, every later read throws `BODY_ALREADY_READ`.

## Validate a body with a schema

`json(schema)` resolves to the output of the schema, whose type TypeScript infers from the schema:

```ts
import { z } from 'zod'

const Order = z.object({ sku: z.string(), quantity: z.number().int().positive() })

app.post('/orders', async c => {
  const order = await c.req.body.json(Order)
  return c.json({ sku: order.sku, quantity: order.quantity }, 201)
})
```

When the schema rejects the body, the client receives a 400 with the code `VALIDATION_FAILED` and the first problems under `issues`:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request body failed validation.",
    "issues": [{ "message": "Invalid input: expected number, received string", "path": ["quantity"] }]
  }
}
```

The package sends at most 10 problems, cuts each message to 256 characters, and keeps the first 16 segments of each path. It sets these caps because a validator can report one problem for each element of an array, so a 1 MiB body that holds an array of 349,524 empty strings leads Zod to report 349,524 problems against an array of numbers.

When a validator throws or rejects, the package catches the error, so the client receives a 500 while your logger receives a `UhttpError` with the code `INVALID_SCHEMA`, whose cause is the error from the validator.

## Stream a large body

`c.req.body.stream()` returns an async iterable of byte chunks, which the package copies out of the memory of uWebSockets.js. Your code receives one chunk at a time, so this handler can hash a 512 MiB body without keeping all of it in memory:

```ts
import { createHash } from 'node:crypto'

app.put('/blobs/:id', { maxBodyBytes: 512 * 1024 * 1024 }, async c => {
  const hash = createHash('sha256')
  for await (const chunk of c.req.body.stream()) hash.update(chunk)
  return c.json({ id: c.req.param('id'), sha256: hash.digest('hex') })
})
```

Once the package holds 64 KiB of the body that your code hasn't read, it pauses the uWebSockets.js socket until your code reads enough to bring that figure below 64 KiB. uWebSockets.js clears its 10-second idle timer while the package keeps a socket paused, so the package closes the connection itself once the socket stays paused for 10 seconds.

Because uWebSockets.js also stops writing to a paused socket, the package stops pausing the socket once a streamed reply starts, so it can then hold up to the body limit of the route in bytes that your code hasn't read.

## Set the body limit

The app accepts a body of up to 1 MiB by default. Pass `maxBodyBytes` to `createApp()` to change the limit of every route, and pass it to a route to set the limit of that route:

```ts
const app = createApp({ maxBodyBytes: 64 * 1024 })
  .post('/comments', async c => c.json(await c.req.body.json()))
  .post('/imports', { maxBodyBytes: 50 * 1024 * 1024 }, async c => c.text(await c.req.body.text()))
```

Because a chunked body declares no length, the package counts the bytes of the body as it receives them. Once the count passes the limit, every read throws a `UhttpError` with the code `PAYLOAD_TOO_LARGE`, which the client receives as a 413. After any `PAYLOAD_TOO_LARGE` error, including one from a form or an upload, the package closes the connection once the reply has gone out, as nginx, Apache httpd, and Go's HTTP server do after a body above their limits. Your error handler can change the reply, but the connection still closes.

When the client declares a `Content-Length` above the limit, the package answers 413 before it reads any of the body. It skips the handler of the route for that request, but it still calls the middleware of the route around the 413, so a CORS middleware can add its headers to it.

The package sends the 413 straight away, while the client may still be sending the body, and it closes the connection after the reply. When a client sends `Expect: 100-continue`, uWebSockets.js writes `100 Continue` before it calls the package, so that client sends its body as well.

## How the connection ends after a body

When a server closes a socket that still holds unread bytes, the operating system resets the connection, which can discard the reply before the client reads it. While the body is still arriving, the package therefore keeps reading and discarding it after a reply with `Connection: close`. A client closes the connection once it has read such a reply. When the client keeps the connection open, the package closes it after 30 seconds, which matches the default `lingering_time` of nginx. Because the package delivers the whole reply first, a client that keeps sending for those 30 seconds has had time to read it.

When a handler replies without reading the whole body, the package discards the rest. When up to 256 KiB of a body with a `Content-Length` is still on its way, the client can send its next request on the same connection once the body ends. When more is on its way, or when a chunked body has not ended, reading the rest would cost more than a new connection, so the package closes the connection as it does after a 413. Go's HTTP server applies the same 256 KiB limit. The package follows the same rules for a route without a body reader.

A streamed reply carries `Connection: close` in its head when the package will close the connection, and the package holds the end of that reply until the last byte of the body arrives. When the body is still arriving 30 seconds later, the package waits for the reply to drain, stops reading the body, and ends the reply. uWebSockets.js then closes the idle connection about 10 seconds later, or at once when the client sent `Connection: close`.

## Compressed request bodies

The package accepts only uncompressed request bodies, because a small compressed body can expand to many times its size. On a route with a body reader, the package answers a request whose `Content-Encoding` is anything other than `identity` with a 415 and the code `UNSUPPORTED_MEDIA_TYPE`, before it reads any of the body. It adds the header `Accept-Encoding: identity` to that 415, so that the client can send the body again without compression. As after a 413, it then closes the connection.

## Set a time limit on a handler

Neither the app nor a route has a time limit by default. Pass `timeoutMs` to `createApp()` to give every handler a time limit, and pass it to a route to set the limit of that route. Pass 0 to a route to switch off the limit of the app for that route:

```ts
const app = createApp({ timeoutMs: 5_000 })
  .get('/reports/:id', async c => c.json(await buildReport(c.req.param('id'), c.req.signal)))
  .post('/exports', { timeoutMs: 0 }, async c => c.json(await runExport(c.req.signal)))
```

When a handler passes its time limit, the package aborts `c.req.signal` with a `UhttpError` whose code is `HANDLER_TIMEOUT` as the reason, and every pending read of the body rejects with that error. The package then sends the reply that your error handler returns for that error, which is a 503 with the code `HANDLER_TIMEOUT` when the app has no error handler, and it closes the connection after that reply. The package sends the headers that a middleware set before the limit, such as CORS headers, with that reply. It also passes a warning with the method, the path, and the limit to `logger.warn`.

The handler goes on executing after its limit, because JavaScript has no way to stop a function from outside. The package discards whatever reply the handler returns afterwards, so a client that retries after a 503 can make the handler repeat its work. Pass `c.req.signal` to every call that accepts one, so that those calls stop at the limit. Make each handler that changes data safe to repeat as well, for example with an idempotency key that your client sends with each request.

## Test a route with a body

Pass `body` to `app.request()` as text, as bytes, or as a list or an async iterable of chunks. `app.request()` sends text and bytes with a `Content-Length`, and chunks with `Transfer-Encoding: chunked`, unless your headers set either one:

```ts
const response = await app.request('/users', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Ama', email: 'ama@example.com' }),
})
```

Because the network can split a body at any byte, a parser that reads one chunk at a time can fail at a split. Pass the body as a list of chunks to test every split:

```ts
const body = Buffer.from('{"name":"Ama","email":"ama@example.com"}')

for (let position = 1; position < body.byteLength; position++) {
  const response = await app.request('/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: [body.subarray(0, position), body.subarray(position)],
  })
  console.assert(response.status === 201)
}
```
