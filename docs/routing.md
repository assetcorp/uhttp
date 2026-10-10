# Routing and middleware

A uhttp app matches each request to a route by its method and its path. It then sends the request through the middleware of that route to the route's handler. Every middleware and handler receives a request context that the package copies from uWebSockets.js before the first `await`, so your code can await anything without losing the request.

```ts
import { createApp, serve } from '@delali/uhttp'

const app = createApp()
  .get('/users', c => c.json({ users: ['Ama', 'Kofi'] }))
  .get('/users/:id', c => c.json({ id: c.req.param('id') }))
  .post('/users', c => c.json({ created: true }, 201))

const server = await serve({ app, port: 3000 })
```

## Add routes

The app and each group have `get`, `post`, `put`, `patch`, `delete`, and `options`. Each of these methods takes a path and a handler. It returns the app or the group, so that you can chain the next route.

A path starts with `/` and contains two kinds of segment:

- A static segment, such as `users`, matches the same text in the raw request path.
- A parameter segment, such as `:id`, matches any segment of the raw path that is not empty.

The router matches a path exactly and with its case, so `/users`, `/users/`, and `/Users` are three separate paths. A path can contain no regular expression and no wildcard, because a regular expression can take exponential time on a path that an attacker crafts, as [OWASP's page on ReDoS](https://community.owasp.org/attacks/Regular_expression_Denial_of_Service_-_ReDoS) explains. When you add a path that breaks these rules, or a second route with the same method and the same shape, the method throws a `UhttpError` with the code `INVALID_ROUTE`.

Where a static route and a parameter route could both match, the router compares the static segment first. When that branch fails further along the path, the router backtracks to the parameter, so `/pages/about/edit` reaches `/pages/:slug/edit` even though the app also has `/pages/about/team`.

The package registers every route with the native router of uWebSockets.js, so a request that matches a route never reaches the JavaScript matcher. The package uses the JavaScript matcher for `app.request()` and for the 404, 405, and OPTIONS answers. A test in the repository sends every route through both matchers, and it fails when their results differ.

## Read path parameters

After the router has split the raw path on `/`, it decodes each parameter value once. An encoded slash therefore stays inside one parameter:

```ts
const app = createApp().get('/files/:name', c => c.text(c.req.param('name') ?? ''))

// GET /files/report%2F2026.pdf sends 'report/2026.pdf'
// GET /files/report/2026.pdf gets a 404
```

`c.req.params()` returns every parameter of the route as an object. When a parameter contains a percent sequence that fails to decode, such as `%E0%A4%A`, the client receives a 400 with the code `INVALID_PATH_PARAMETER`. The app's middleware wraps that 400 as it wraps any other reply.

## HEAD, OPTIONS, 405, and 404

The package adds a HEAD route beside every GET route. For a HEAD request, it calls the GET handler and sends the headers of its reply, including the length of the body, with no body. `c.req.method` is `HEAD` in that case, so a handler can skip expensive work.

When a request uses a method that the path has no route for, the client receives a 405 with an `Allow` header whose value is every method of the path. For an OPTIONS request to a path with routes, the client receives a 204 with the same `Allow` header, unless you add an OPTIONS route for that path. For a path with no route at all, the client receives a JSON 404:

```json
{ "error": { "code": "NOT_FOUND", "message": "The app has no route for this path." } }
```

The package matches the method in upper case alone, so a request that sends `get` receives a 405 from a path that has a GET route.

## Add middleware

A middleware receives the context and `next`. It can work before `await next()` and on the reply after it. It can also end the request with its own reply without calling `next`:

```ts
import { createApp, type Middleware } from '@delali/uhttp'

const timing: Middleware = async (c, next) => {
  const started = performance.now()
  await next()
  c.header('server-timing', `app;dur=${(performance.now() - started).toFixed(1)}`)
}

const app = createApp().use(timing)
```

You can add middleware at three levels. In this example, `requireLogin` and `auditLog` are middleware like `timing`, and a later section shows how `requireLogin` uses a header:

```ts
const app = createApp().use(timing)

const admin = app.group('/admin', requireLogin)
admin.get('/stats', c => c.json({ users: 2 }))

app.get('/reports/:id', auditLog, c => c.json({ id: c.req.param('id') }))
```

The package builds the chain of each route at startup, in the order app, group, then route. It applies every app middleware to every route, whether you called `use` before or after you added the route. When a middleware returns a reply after `await next()`, that reply replaces the handler's reply. At any point after `next()` returns, `c.reply` is the current reply.

## Groups are prefix guards

A group's middleware wraps every request whose raw path starts with the group's prefix, segment by segment. Because the package compares raw segments, the middleware of the group `/admin` wraps `/admin` and `/admin/stats` while it leaves `/administrator` alone. An encoded spelling such as `/%61dmin/stats` matches no admin route either, so the client receives a 404. A route that you add outside the group still passes through the group's middleware when its path falls under the prefix:

```ts
const app = createApp()
app.group('/admin', requireLogin)
app.get('/:section/settings', c => c.text('settings'))

// GET /admin/settings passes through requireLogin
```

The app's middleware wraps the 404, 405, and OPTIONS answers too, and so does the middleware of every group whose prefix matches the path. A CORS middleware, a rate limit, or an access log can therefore apply to every response, including a preflight to a path that has no OPTIONS route.

Groups can nest, in which case the middleware of the outer group wraps the middleware of the inner one. Inside a group, the path `/` maps to the group prefix itself, so `app.group('/admin').get('/', handler)` matches `/admin`.

## Declare the headers that a route uses

The package copies the method, the path, the query string, the path parameters, the content type, and the content length for every request. It copies any other request header only when the route or one of its middleware declares it, because each copied header adds work to every request of that route. Pass a `RouteOptions` object before the handler to declare headers or the client address:

```ts
app.get('/me', { headers: ['authorization'] }, c => {
  const token = c.req.header('authorization')
  return c.json({ signedIn: token !== undefined })
})

app.get('/where', { clientAddress: true }, c => c.text(c.req.clientAddress))
```

A middleware declares the headers that it uses in the same way, as an object with a `handle` function. The package then copies those headers for every route that the middleware wraps:

```ts
const requireLogin: Middleware = {
  headers: ['authorization'],
  handle: async (c, next) => {
    if (c.req.header('authorization') === undefined) return c.json({ error: 'Sign in first.' }, 401)
    await next()
  },
}
```

`c.req.header()` throws a `UhttpError` with the code `UNDECLARED_HEADER` when nobody declared the header, so the first test that reaches that code fails with the name of the missing header in its message. Reading `c.req.clientAddress` without a declaration throws `UNDECLARED_CLIENT_ADDRESS` in the same way.

For a header that a client can send on several lines, such as `x-forwarded-for` or `cookie`, the package collects every line and joins them, with `; ` between cookie lines and `, ` between the lines of any other list header. For any other header, it copies the first line. For a route such as a proxy, pass `{ headers: 'all' }` to copy every header, and `c.req.headers()` then returns all of them.

## Stop work for a client that has gone

`c.req.signal` is an `AbortSignal` that fires when the client disconnects before the response ends. The package creates it the first time that code asks for it, so it does no work for the signal on a route that never uses it:

```ts
app.get('/stock', async c => {
  const upstream = await fetch('https://inventory.example.com/stock', { signal: c.req.signal })
  return c.json(await upstream.json())
})
```

## Test a route without a port

`app.request()` sends a request through the same matcher, middleware chain, and request context as a request from the network. It returns a `Response` with the status, the headers, and the body:

```ts
const response = await app.request('/users/42', { headers: { authorization: 'Bearer abc' } })
console.log(response.status, await response.json())
```

It applies the checks that uWebSockets.js v20.71.0 applies to every request. It lowercases header names and trims the spaces around each value. It returns the same 400 as uWebSockets.js for more than 98 header lines and for an empty, repeated, or invalid `Host`. It returns that 400 too when the request line and the headers take more than 4,096 bytes, or more than `UWS_HTTP_MAX_HEADERS_SIZE` where you set it. When your headers include no `Host`, it sends `host: localhost`, as `fetch` does. Pass `clientAddress` to set the address that a handler gets, and pass `signal` to test what happens when the client disconnects.
