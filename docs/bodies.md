# Request bodies and validation

A handler reads the body of a request through `c.req.body`, either as a stream of byte chunks or through a parser for JSON, text, bytes, or a URL-encoded form. `json(schema)` checks the parsed body against a schema from any validator that implements [Standard Schema](https://standardschema.dev), such as Valibot, Zod, or ArkType, and the package depends on none of them. The package enforces the body limit of the route on every read, and that limit is 1 MiB unless you set another.

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

The package attaches a body reader to every POST, PUT, and PATCH route. It attaches none to the routes of other methods, because the package does more work on every request of a route with a reader, even on a request without a body. Set `body: true` in the options of a route to read the body of a DELETE or a GET request, and set `body: false` to leave the reader off a POST route that ignores its body:

```ts
app.delete('/sessions', { body: true }, async c => {
  const { ids } = (await c.req.body.json()) as { ids: string[] }
  return c.json({ revoked: ids.length })
})
```

When a route without a reader reads `c.req.body`, the read throws a `UhttpError` with the code `UNDECLARED_BODY`, so the first test of that route fails with a message that names the option.

The package attaches the reader inside the synchronous handler of uWebSockets.js, after it copies the request. A middleware can therefore await a database or a remote service before the handler reads the body, and the handler still receives every byte, because uWebSockets.js can drop the bytes that arrive before a reader exists.

## Parse JSON, text, bytes, and forms

Each parser checks the `Content-Type` of the request before it reads any of the body, and it throws a `UhttpError` with the code `UNSUPPORTED_MEDIA_TYPE`, which the client receives as a 415, when the type does not match.

| Method | Content types that it accepts | What it returns |
| --- | --- | --- |
| `json()` | `application/json` and any `application/*+json`, in UTF-8 | The parsed value |
| `json(schema)` | The same as `json()` | The output of the schema |
| `text()` | Any `text/*`, decoded in its `charset`, which is UTF-8 when the request names none | A string |
| `bytes()` | Any type | A `Uint8Array` |
| `form()` | `application/x-www-form-urlencoded` | A flat map of names and values |

`json()` answers 400 with the code `INVALID_JSON` when the body fails to parse. It refuses a body with a `__proto__` key at any depth, or with a `constructor` key whose value has a `prototype` key, because code that merges such an object into another can change the prototype of every object in the process.

`form()` parses a URL-encoded body into a map with no bracket or dot nesting, so `user[name]=Ama` arrives under the name `user[name]`. A name that the form repeats, such as a group of checkboxes, arrives as a list of its values. The map has no prototype, so a field named `__proto__` is an ordinary entry. `form()` counts the parameters as it parses them and answers 413 once a body passes 1,000.

You can read a body more than once with the parsers, because the package keeps the bytes after the first read. Once your code has streamed the body, every later read throws `BODY_ALREADY_READ`.

## Validate a body with a schema

Pass a schema to `json()`, and the promise resolves to the output of the schema, typed from it:

```ts
import { z } from 'zod'

const Order = z.object({ sku: z.string(), quantity: z.number().int().positive() })

app.post('/orders', async c => {
  const order = await c.req.body.json(Order)
  return c.json({ sku: order.sku, quantity: order.quantity }, 201)
})
```

When the body fails the schema, the client receives a 400 with the code `VALIDATION_FAILED` and the first problems under `issues`:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request body failed validation.",
    "issues": [{ "message": "Invalid input: expected number, received string", "path": ["quantity"] }]
  }
}
```

The package sends no more than 10 problems, cuts each message to 256 characters, and keeps the first 16 segments of each path. A validator can report one problem for every element of a large array, so without these caps a single request could make the server build and send a reply far larger than the body. The package awaits the validator inside a guard, so when a validator throws or rejects, the client receives a 500 and the package passes an error with the code `INVALID_SCHEMA` to your logger.

## Stream a large body

`c.req.body.stream()` returns an async iterable of copied byte chunks. Your code holds one chunk at a time, and the package pauses the upload while your code holds the next chunk back:

```ts
import { createHash } from 'node:crypto'

app.put('/blobs/:id', { maxBodyBytes: 512 * 1024 * 1024 }, async c => {
  const hash = createHash('sha256')
  for await (const chunk of c.req.body.stream()) hash.update(chunk)
  return c.json({ id: c.req.param('id'), sha256: hash.digest('hex') })
})
```

The package pauses the uWebSockets.js socket once 64 KiB of the body wait unread, and it resumes the socket once your code reads them. uWebSockets.js stops its own 10-second idle timer while the socket is paused, so the package closes the connection itself when the upload stays paused for 10 seconds. uWebSockets.js stops writes on a paused socket too, so once a streamed reply starts, the package stops pausing the socket, and the body limit of the route then bounds the bytes that wait unread.

## Set the body limit

The app accepts a body of up to 1 MiB by default. Pass `maxBodyBytes` to `createApp()` to change the limit of every route, and pass it to a route to set the limit of that route:

```ts
const app = createApp({ maxBodyBytes: 64 * 1024 })
  .post('/comments', async c => c.json(await c.req.body.json()))
  .post('/imports', { maxBodyBytes: 50 * 1024 * 1024 }, async c => c.text(await c.req.body.text()))
```

The package counts the bytes of the body as they arrive, because a chunked body declares no length. Once the count passes the limit, every read throws a `UhttpError` with the code `PAYLOAD_TOO_LARGE`, and the client receives a 413. When a request declares a `Content-Length` above the limit, the package answers 413 before it reads any of the body, and the handler of the route never runs, while the middleware of the route still wraps the 413.

The package closes the connection after every 413, because uWebSockets.js has already invited the client to send the body, and the rest of that body would otherwise reach the server.

## Compressed request bodies

The package accepts uncompressed request bodies alone, because a small compressed body can expand to many times its size. On a route with a body reader, it answers a request whose `Content-Encoding` is anything other than `identity` with a 415, the code `UNSUPPORTED_MEDIA_TYPE`, and the header `Accept-Encoding: identity`, so that the client can send the body again without compression. It closes the connection after that 415 too.

## Set a time limit on a handler

Neither the app nor a route has a time limit by default. Pass `timeoutMs` to `createApp()` to give every handler a time limit, and pass it to a route to set the limit of that route, where 0 switches the limit off:

```ts
const app = createApp({ timeoutMs: 5_000 })
  .get('/reports/:id', async c => c.json(await buildReport(c.req.param('id'), c.req.signal)))
  .post('/exports', { timeoutMs: 0 }, async c => c.json(await runExport(c.req.signal)))
```

When the limit passes, the package fires `c.req.signal` with a `UhttpError` whose code is `HANDLER_TIMEOUT` as its reason, and it fails every pending read of the body with that error. It then sends the reply of your error handler for that error, which is a 503 with the code `HANDLER_TIMEOUT` by default, and it closes the connection. The package sends the headers that a middleware set before the limit passed, such as CORS headers, with the 503, and it passes a warning with the method, the path, and the limit to `logger.warn`.

The handler goes on executing after its limit passes, because JavaScript has no way to stop a function from outside. The package drops the reply that the handler returns later. A client that retries after a 503 can therefore repeat the work of the handler, so pass `c.req.signal` to every call that accepts one, and make a handler that changes data safe to repeat, for example with an idempotency key that your client sends.

## Test a route with a body

Pass `body` to `app.request()` as text, as bytes, or as a list or an async iterable of chunks. `app.request()` sends text and bytes with a `Content-Length`, and chunks with `Transfer-Encoding: chunked`, unless your headers set either one:

```ts
const response = await app.request('/users', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Ama', email: 'ama@example.com' }),
})
```

Pass the body as a list of chunks to test a boundary that falls between two chunks, which is where a parser that reads one chunk at a time can go wrong:

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
