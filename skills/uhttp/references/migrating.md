# Move an app from Express, Fastify, or Hono

## Steps

1. Record the status, the headers, and the body that the old app returns for each route, with curl or the test client of the old framework, and keep those responses to compare.
2. Make the project an ES module, and install uWebSockets.js and uhttp, as step 2 of [SKILL.md](../SKILL.md) shows.
3. Port the routes one file at a time with the tables below. Declare every request header, the client address, and the body of each GET or DELETE route that reads one.
4. Replace each plugin or middleware package with the uhttp middleware in [middleware.md](middleware.md).
5. Replace the call that starts the old server with `serve()` and a handler for `SIGTERM`, as [serving.md](serving.md) shows.
6. Port the tests to `app.request()`, and remove the old framework once every test passes.
7. Send the recorded requests to the new server, and compare each response with the one that the old app returned.

## Behaviour that changes in every move

- The router of uhttp matches each path exactly and with its case. Express 5 matches `/users/` and `/Users` to a route on `/users` by default, so add a route or a redirect for each spelling that clients use.
- A path holds static segments and `:name` parameters alone, so a route method throws `INVALID_ROUTE` for a wildcard, a regular expression, or an optional parameter. Replace a catch-all route with the `notFound` option of `createApp()`, and a route with an optional parameter with two routes.
- uhttp answers an error with `{ "error": { "code", "message" } }`, while Fastify answers with `{ "statusCode", "error", "message" }` and Express answers with an HTML page. Pass `notFound` and `onError` to `createApp()` to keep the shape that the existing clients parse, as [routes.md](routes.md) shows.
- uhttp accepts a body of up to 1 MiB on each route, while `express.json()` accepts 100 KiB by default. Set `maxBodyBytes` to the limit of the old app.
- uhttp parses no body before the handler, so each handler reads its body with `await c.req.body.json()` or another parser.
- Without `host`, uhttp listens on every interface, as Express does, while Fastify listens on `127.0.0.1` by default.

## A route from Express

This Express route reads a token, a path parameter, a query string, and a JSON body:

```js
import express from 'express'

const app = express()
app.use(express.json())

app.post('/stores/:storeId/orders', (req, res) => {
  if (req.get('authorization') === undefined) return res.status(401).json({ error: 'Sign in first.' })
  res.status(201).json({ store: req.params.storeId, notify: req.query.notify === 'true', order: req.body })
})

app.listen(3000)
```

In uhttp, the route declares the header that it reads, returns each reply, and reads its body in the handler:

```ts
import { createApp, serve } from '@delali/uhttp'

const app = createApp({ logger: console, maxBodyBytes: 100 * 1024 }).post(
  '/stores/:storeId/orders',
  { headers: ['authorization'] },
  async c => {
    if (c.req.header('authorization') === undefined) return c.json({ error: 'Sign in first.' }, 401)
    const notify = new URLSearchParams(c.req.query).get('notify') === 'true'
    return c.json({ store: c.req.param('storeId'), notify, order: await c.req.body.json() }, 201)
  },
)

await serve({ app, port: 3000 })
```

## From Express

| Express | uhttp |
| --- | --- |
| `req.params.id` | `c.req.param('id')` |
| `req.query.page` | `new URLSearchParams(c.req.query).get('page')` |
| `req.get('authorization')` | `c.req.header('authorization')`, with `headers: ['authorization']` on the route or its middleware |
| `req.ip` | `clientAddressOf(c)` behind `trustedProxies()`, or `c.req.clientAddress` with `clientAddress: true` |
| `express.json()` and `req.body` | `await c.req.body.json()`, or `await c.req.body.json(schema)` to validate |
| `express.urlencoded()` | `await c.req.body.form()` |
| `multer` | `await c.req.body.multipart()`, as [uploads.md](uploads.md) shows |
| `res.status(201).json(order)` | `return c.json(order, 201)` |
| `res.send(text)` | `return c.text(text)` |
| `res.set(name, value)` | `c.header(name, value)` |
| `res.redirect(url)` | `return c.redirect(url)` |
| `res.locals.user` or `req.user` | `c.set('user', user)` and `c.get('user')` |
| `(req, res, next) => { next() }` | `async (c, next) => { await next() }`, or `{ before: c => {} }` for a check |
| `(err, req, res, next) => {}` | `createApp({ onError: (error, c) => c.json({ error: 'Failed.' }, 500) })` |
| `express.Router()` with `app.use('/admin', router)` | `app.group('/admin', ...middleware)` |
| `express.static('public')` | `serveStatic({ root: './public' })` |
| `cors`, `helmet`, `express-rate-limit`, `cookie-parser`, `compression`, and `morgan` | `cors()`, `secureHeaders()`, `rateLimit()`, `cookies()`, `compression()`, and `accessLog()` |
| `ws` on `server.on('upgrade')` | `app.ws(path, { open, message, close })`, as [websockets.md](websockets.md) shows |
| `supertest(app).get('/users')` | `await app.request('/users')` |
| `app.listen(3000)` | `await serve({ app, port: 3000 })` |

## From Fastify

| Fastify | uhttp |
| --- | --- |
| `fastify.get('/users/:id', async () => user)` | `app.get('/users/:id', c => c.json(user))`, because uhttp sends only a reply that a helper builds |
| `request.params`, `request.query`, and `request.headers` | `c.req.param()`, `c.req.query`, and `c.req.header()`, as in the Express table |
| `request.body` with a JSON schema under `schema.body` | `await c.req.body.json(schema)` with a Standard Schema from Valibot, Zod, or ArkType |
| `reply.code(201).send(order)` | `return c.json(order, 201)` |
| `reply.header(name, value)` | `c.header(name, value)` |
| `onRequest` and `preHandler` hooks | A middleware object with `before` |
| `onSend` and `onResponse` hooks | A function middleware that works after `await next()`, or `accessLog()` |
| `fastify.register(routes, { prefix: '/v1' })` | A function that takes `app.group('/v1')` and adds the routes to it |
| `fastify.decorateRequest('user', null)` and `request.user` | `c.set('user', user)` and `c.get('user')` |
| `setErrorHandler` and `setNotFoundHandler` | The `onError` and `notFound` options of `createApp()` |
| `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/cookie`, `@fastify/compress`, and `@fastify/static` | The matching uhttp middleware |
| `@fastify/multipart` and `@fastify/websocket` | `c.req.body.multipart()` and `app.ws()` |
| `fastify.log` | The pino logger that you pass to `createApp()` |
| `fastify.inject({ method, url })` | `app.request(url, { method })` |
| `fastify.listen({ port })` | `serve({ app, port, host: '127.0.0.1' })`, which keeps the default address of Fastify |

## From Hono

| Hono | uhttp |
| --- | --- |
| `new Hono()` | `createApp()` |
| `c.req.param('id')` | `c.req.param('id')` |
| `c.req.query('page')` | `new URLSearchParams(c.req.query).get('page')`, because `c.req.query` holds the raw query string |
| `c.req.header('x-api-key')` | `c.req.header('x-api-key')`, with `headers: ['x-api-key']` on the route or its middleware |
| `await c.req.json()` | `await c.req.body.json()` |
| `zValidator('json', schema)` and `c.req.valid('json')` | `await c.req.body.json(schema)` |
| `await c.req.parseBody()` | `await c.req.body.form()`, or `await c.req.body.multipart()` for files |
| `c.json()`, `c.text()`, `c.redirect()`, and `c.header()` | The same names |
| `c.html(page)` | `c.text(page, 200, { 'content-type': 'text/html; charset=UTF-8' })` |
| `c.body(bytes)` | `c.bytes(bytes)` |
| `c.set()`, `c.get()`, and `c.var` | `c.set()` and `c.get()`, which returns `unknown` |
| `app.route('/admin', admin)` and `app.use('/admin/*', guard)` | `app.group('/admin', guard)` |
| `streamSSE(c, callback)` | `c.sse(callback)` |
| `upgradeWebSocket` from `@hono/node-ws` | `app.ws()` |
| `app.notFound()` and `app.onError()` | The `notFound` and `onError` options of `createApp()` |
| `hono/cors`, `hono/secure-headers`, `hono/csrf`, `hono/compress`, `hono/request-id`, `hono/cookie`, and `hono/logger` | `cors()`, `secureHeaders()`, `csrf()`, `compression()`, `requestId()`, `cookies()`, and `accessLog()` |
| `serve({ fetch: app.fetch, port })` from `@hono/node-server` | `serve({ app, port })` |
| `app.request('/users')` | `app.request('/users')` |

uhttp has no typed client like the `hc` client of Hono, so a frontend that calls the app through `hc` moves to `fetch`.
