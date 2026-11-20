# Routes, middleware, bodies, and replies

## Add routes and groups

`createApp()` returns an app with the route methods `get`, `post`, `put`, `patch`, `delete`, `options`, and `ws`, and each of them returns the app so that the next call can chain. A route method takes the path first, then any middleware and any `RouteOptions` object for that route alone, and the handler last. `app.group(prefix, ...middleware)` returns a group with the same methods.

```ts
import { type Context, createApp, type Middleware, serve, UhttpError } from '@delali/uhttp'

interface Account {
  id: string
  name: string
}

const accountsByToken = new Map<string, Account>([['token-ama', { id: 'acc_1', name: 'Ama' }]])

const requireAccount: Middleware = {
  headers: ['authorization'],
  before: c => {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '')
    const account = token === undefined ? undefined : accountsByToken.get(token)
    if (account === undefined) return c.json({ error: 'Sign in first.' }, 401)
    c.set('account', account)
  },
}

const accountOf = (c: Context) => c.get('account') as Account

const app = createApp({ logger: console }).get('/products', c => {
  const search = new URLSearchParams(c.req.query)
  return c.json({ term: search.get('q') ?? '', page: Number(search.get('page') ?? '1') })
})

app
  .group('/account', requireAccount)
  .get('/orders/:id', c => c.json({ id: c.req.param('id'), owner: accountOf(c).name }))
  .delete('/orders/:id', c => {
    throw new UhttpError('NOT_FOUND', `No order has the id ${c.req.param('id')}.`)
  })

await serve({ app, port: 3000 })
```

- A path holds static segments and `:name` parameters alone. The router matches it exactly and with its case, and it decodes each parameter once, so `c.req.param('name')` keeps an encoded slash inside one value. `c.req.params()` returns every parameter as an object.
- `c.req.query` holds the raw query string without the `?`, so parse it with `new URLSearchParams(c.req.query)`.
- uhttp answers HEAD on every GET route with the headers of the GET reply. It answers 405 with an `Allow` header for a method that the path lacks, 204 with the same header for an OPTIONS request to a path without an OPTIONS route, and a JSON 404 for a path with no route.
- `c.req.route` holds the path pattern of the matched route, with the prefix of its group, such as `/account/orders/:id`, which suits a log line or a metric.

## Middleware

A middleware takes one of two forms:

- A function `async (c, next) => { ... }` wraps the rest of the chain. After `await next()`, `c.reply` holds the reply, and the function can set headers on it or return another reply to replace it.
- An object with a `before` function works before the handler alone. `before` ends the request when it returns a reply, and passes the request on when it returns nothing. The object lists the request headers that it reads in `headers`, and sets `clientAddress: true` when it reads the client address. Write a check that only ends or passes a request in this form, because uhttp waits on every request that a function middleware wraps, while it sends the reply of a synchronous handler behind a synchronous `before` within the same call from uWebSockets.js.

```ts
import { createApp, type Middleware } from '@delali/uhttp'

const timing: Middleware = async (c, next) => {
  const started = performance.now()
  await next()
  c.header('server-timing', `app;dur=${(performance.now() - started).toFixed(1)}`)
}

export const app = createApp({ logger: console })
  .use(timing)
  .get('/health', c => c.text('ok'))
```

- uhttp builds each chain at startup in the order app, group, and route. Every middleware that `app.use()` adds applies to every route, whatever the order of the calls.
- uhttp calls the middleware of a group for every request whose raw path starts with the prefix of the group, including a request for a route that you add outside the group, so a group guards its whole prefix.
- `c.set(key, value)` stores a value for the rest of the request. `c.get(key)` returns that value as `unknown`, so read each value through one typed function, as `accountOf` does above.
- A middleware calls `next()` once. A second call rejects with `NEXT_CALLED_TWICE`.

## Read the request body

uhttp attaches a body reader to every POST, PUT, and PATCH route. Set `body: true` in the options of a GET or a DELETE route that reads a body, and `body: false` on a POST route that ignores its body.

| Method | Content types that it accepts | What it returns |
| --- | --- | --- |
| `c.req.body.json()` | `application/json` and every `application/*+json` | The parsed value |
| `c.req.body.json(schema)` | The same types | The output of a Standard Schema, such as one from Valibot, Zod, or ArkType |
| `c.req.body.text()` | Every `text/*` | A string |
| `c.req.body.bytes()` | Every type | A `Uint8Array` |
| `c.req.body.form()` | `application/x-www-form-urlencoded` | A flat map of names and values, with a list for a repeated name |
| `c.req.body.stream()` | Every type | An async iterable of byte chunks |
| `c.req.body.multipart()` | `multipart/form-data` | The fields and the files, as [uploads.md](uploads.md) describes |

`app.ts` exports this app, so that a server module can pass it to `serve()` and a test can import it:

```ts
import { createApp } from '@delali/uhttp'
import * as v from 'valibot'

const NewOrder = v.object({ sku: v.string(), quantity: v.pipe(v.number(), v.integer(), v.minValue(1)) })
const SessionIds = v.object({ ids: v.array(v.string()) })

export const app = createApp({ logger: console, maxBodyBytes: 64 * 1024, timeoutMs: 5_000 })
  .post('/orders', async c => {
    const order = await c.req.body.json(NewOrder)
    return c.json({ sku: order.sku, quantity: order.quantity }, 201, { location: `/orders/${order.sku}` })
  })
  .delete('/sessions', { body: true }, async c => {
    const { ids } = await c.req.body.json(SessionIds)
    return c.json({ revoked: ids.length })
  })
```

- Each parser answers 415 with `UNSUPPORTED_MEDIA_TYPE` for a content type outside its list, and for a request body with a `Content-Encoding` other than `identity`. `json()` answers 400 with `INVALID_JSON` for malformed JSON and for a `__proto__` key at any depth. When a schema refuses the body, uhttp answers 400 with `VALIDATION_FAILED` and up to 10 problems under `issues`.
- Each route accepts a body of up to 1 MiB by default. Set `maxBodyBytes` on `createApp()` or on a route to change that limit. Past it, uhttp answers 413 with `PAYLOAD_TOO_LARGE` and closes the connection after the reply.
- A parser keeps the bytes that it reads, so a second parser call works. Once code streams a body that no parser has read, every later read throws `BODY_ALREADY_READ`.
- No route has a time limit by default. Set `timeoutMs` on `createApp()` or on a route, and past that limit uhttp aborts `c.req.signal` and answers 503 with `HANDLER_TIMEOUT`. The handler goes on executing after the limit, so pass `c.req.signal` to every call that accepts a signal.

## Build replies

- `c.text(body, status, headers)`, `c.json(value, status, headers)`, and `c.bytes(data, status, headers)` build a reply with the status 200 unless you pass another. `c.redirect(location, status)` sends 302 unless you pass 301, 303, 307, or 308.
- A `content-type` in the headers replaces the type of the helper, so send HTML with `c.text(page, 200, { 'content-type': 'text/html; charset=UTF-8' })`. Send a 204 with `c.text('', 204)`, and pass an array for a header with several lines.
- `c.header(name, value)` sets a header on whatever reply the request ends with, including an error reply, and `{ append: true }` adds a line after the earlier lines.
- uhttp throws `INVALID_HEADER` for a header name that is not an HTTP token and for a value with a line break or another control character, so a value from user input can never add a header line.
- `c.stream(producer, { contentType, length })` streams a body in chunks. Each `stream.write()` resolves once the client can take more, and it resolves to `false` once the client has gone.
- `c.sse(producer, { heartbeatMs })` streams server-sent events, with a heartbeat comment every 30 seconds by default. `events.send()` resolves to `false` once the client has gone:

```ts
import { setTimeout as sleep } from 'node:timers/promises'
import { createApp, serve } from '@delali/uhttp'

const app = createApp({ logger: console }).get('/prices', c =>
  c.sse(async events => {
    for (let sequence = 1; sequence <= 3; sequence++) {
      const price = { sequence, cedis: 12.5 + sequence }
      const sent = await events.send({ event: 'price', id: String(sequence), data: JSON.stringify(price) })
      if (!sent) return
      await sleep(1_000)
    }
  }),
)

await serve({ app, port: 3000 })
```

## Errors

Throw `new UhttpError(code, message)` with a code from `ErrorCode` in the installed `errors.d.ts`, such as `NOT_FOUND`, and uhttp answers with the status of that code and `{ "error": { "code", "message" } }`. For a status without a code, such as 409, return `c.json(body, 409)`. For every error that maps to 500, including an error that is not a `UhttpError`, uhttp sends the code `INTERNAL_ERROR` with the message 'The request failed.', and it passes the error itself to the logger.

Pass `notFound` and `onError` to `createApp()` to send another shape, such as the error shape that the existing clients of an app parse:

```ts
import { createApp, UhttpError } from '@delali/uhttp'

export const app = createApp({
  logger: console,
  notFound: c => c.json({ title: 'Not Found', detail: `No route matches ${c.req.path}.` }, 404),
  onError: (error, c) => {
    if (error instanceof UhttpError && error.status < 500) {
      return c.json({ title: error.code, detail: error.message }, error.status)
    }
    return c.json({ title: 'Server Error' }, 500)
  },
}).get('/health', c => c.text('ok'))
```

## Test without a port

`app.request(target, init)` sends a request through the same matcher, middleware, and request copy as a request from the network, and it returns a `Response`. A test with `node:test` can import the app from `app.ts` above and send it requests:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { app } from './app.ts'

test('an order with a quantity of zero fails validation', async () => {
  const response = await app.request('/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'kente-01', quantity: 0 }),
  })
  assert.equal(response.status, 400)
  const reply = (await response.json()) as { error: { code: string } }
  assert.equal(reply.error.code, 'VALIDATION_FAILED')
})
```

- Pass `clientAddress` in `init` to set the address that `c.req.clientAddress` returns, and `signal` to abort the request as a client that disconnects.
- Pass `body` as a list of chunks, such as `[bytes.subarray(0, 10), bytes.subarray(10)]`, to test a body that the network splits.
- `app.request()` skips the code that writes the reply to the socket, so finish with a request over the network, as step 5 of [SKILL.md](../SKILL.md) says.
