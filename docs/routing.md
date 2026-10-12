# Routing and middleware

A uhttp app matches each request to a route by its method and its path. The package then calls the middleware of that route and, last, the route's handler. Before the first `await`, the package copies what the route uses from uWebSockets.js into a request context, so your code can await anything and still use every part of the request that it declared.

```ts
import { createApp, serve } from '@delali/uhttp'

const app = createApp()
  .get('/users', c => c.json({ users: ['Ama', 'Kofi'] }))
  .get('/users/:id', c => c.json({ id: c.req.param('id') }))
  .post('/users', c => c.json({ created: true }, 201))

const server = await serve({ app, port: 3000 })
```

## Add routes

The app and each group have the methods `get`, `post`, `put`, `patch`, `delete`, and `options`. Each of them takes a path and a handler and returns the app or the group, so that you can chain the next route.

A path starts with `/` and contains two kinds of segment:

- A static segment, such as `users`, matches the same text in the raw request path.
- A parameter segment, such as `:id`, matches any segment of the raw path that has at least one character.

The router matches a path exactly and with its case, so `/users`, `/users/`, and `/Users` are three separate paths. It matches static segments and parameter segments alone, because a regular expression can take exponential time on a path that an attacker crafts, as [OWASP's page on ReDoS](https://owasp.org/www-community/attacks/Regular_expression_Denial_of_Service_-_ReDoS) explains. When you add a path with any other kind of segment, or a second route with the same method and the same shape, the method throws a `UhttpError` with the code `INVALID_ROUTE`.

Where a static route and a parameter route can both match, the router compares the static segment first. When that branch fails further along the path, the router backtracks to the parameter, so it matches `/pages/about/edit` to `/pages/:slug/edit` even though the app also has `/pages/about/team`.

The package registers every route with the native router of uWebSockets.js, which matches each request to its route in native code. The package uses its JavaScript matcher for `app.request()` and for the 404, 405, and OPTIONS replies alone. A test in the repository sends every route through both matchers, and it fails when their results differ.

## Read path parameters

After the router has split the raw path on `/`, it decodes each parameter value once. An encoded slash therefore stays inside one parameter:

```ts
const app = createApp().get('/files/:name', c => c.text(c.req.param('name') ?? ''))

// GET /files/report%2F2026.pdf returns 'report/2026.pdf'.
// GET /files/report/2026.pdf returns a 404.
```

`c.req.params()` returns every parameter of the route as an object. When a parameter contains a percent sequence that fails to decode, such as `%E0%A4%A`, the package sends a 400 with the code `INVALID_PATH_PARAMETER`. The package calls the app's middleware around that 400 as it does around any other reply.

## HEAD, OPTIONS, 405, and 404

The package adds a HEAD route beside every GET route. For a HEAD request, it calls the GET handler and sends the headers of its reply, including the length of the body, with an empty body. `c.req.method` is `HEAD` in that case, so a handler can skip expensive work.

When a request uses a method that the path has no route for, the package sends a 405 with an `Allow` header whose value is the list of methods of the path. For an OPTIONS request to a path with routes, the package sends a 204 with the same `Allow` header, unless you add an OPTIONS route for that path. For a path with no route at all, the package sends a JSON 404:

```json
{ "error": { "code": "NOT_FOUND", "message": "The app has no route for this path." } }
```

The package matches the method in upper case alone, so it sends a 405 to a request whose method is `get` on a path that has a GET route.

## Add middleware

The package calls a middleware with the context and a function called `next`. Your middleware can work before `await next()` and on the reply after it. It can also end the request with its own reply in place of calling `next`:

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

The package builds the chain of each route at startup, in the order app, group, then route. It applies every app middleware to every route, whether you called `use` before or after you added the route. When a middleware returns a reply after `await next()`, the package sends that reply in place of the handler's reply. At any point after `next()` returns, `c.reply` is the current reply.

## Pass values from middleware to the handler

`c.set(key, value)` stores a value for the rest of the request, and `c.get(key)` returns it, or `undefined` when nothing is stored under the key. A middleware can therefore work something out once and hand it to every handler behind it:

```ts
const tenant: Middleware = async (c, next) => {
  c.set('tenant', c.req.param('tenant'))
  await next()
}

app.get('/:tenant/invoices', tenant, c => c.json({ tenant: c.get('tenant') }))
```

The values belong to one request, so two requests never see each other's values. On a WebSocket route, the values that the chain stores during the upgrade become the `data` of the socket, as [WebSockets](websockets.md) shows.

## Groups are prefix guards

The package calls a group's middleware for every request whose raw path starts with the group's prefix, segment by segment. Because the package compares raw segments, the middleware of the group `/admin` applies to `/admin` and to `/admin/stats`, while the package treats `/administrator` as a path outside the group. An encoded spelling such as `/%61dmin/stats` differs from `/admin` in its raw first segment, so the package treats that path as outside the group too and sends a 404 for it. The package also calls the group's middleware for a route that you add outside the group, whenever the route's path starts with the prefix:

```ts
const app = createApp()
app.group('/admin', requireLogin)
app.get('/:section/settings', c => c.text('settings'))

// The package calls requireLogin for GET /admin/settings.
```

The package calls the app's middleware around the 404, 405, and OPTIONS replies too, together with the middleware of every group whose prefix matches the path. A CORS middleware, a rate limit, or an access log can therefore apply to every response, including a preflight to a path that has no OPTIONS route.

Groups can nest, in which case the package calls the middleware of the outer group before the middleware of the inner one. Inside a group, the path `/` maps to the group prefix itself, so `app.group('/admin').get('/', handler)` matches `/admin`.

## Declare the headers that a route uses

The package copies the method, the path, the path parameters, and the content length for every request. It reads the query string and the content type from uWebSockets.js when your code first asks for them, because each read adds work to the request that makes it. When your handler awaits something or returns a stream, the package copies whatever your code has not read yet before uWebSockets.js frees the request, so you can read both after an `await`. When your handler returns any other reply without an `await`, the package sends that reply at once and frees the request. In that case, read the query string and the content type before the handler returns, including in any task that the handler starts without waiting for it. A first read after that throws `REQUEST_RELEASED`, and so do `c.req.header('content-type')`, `c.req.headers()`, and `c.req.body`, because each of them needs the content type:

```ts
app.get('/search', c => {
  const query = c.req.query
  void recordSearch(query)
  return c.json(findProducts(query))
})
```

The package copies any other request header only when the route or one of its middleware declares it, because the package does more work on every request of a route for each header that it copies. Pass a `RouteOptions` object before the handler to declare headers or the client address:

```ts
app.get('/me', { headers: ['authorization'] }, c => {
  const token = c.req.header('authorization')
  return c.json({ signedIn: token !== undefined })
})

app.get('/where', { clientAddress: true }, c => c.text(c.req.clientAddress))
```

A middleware declares the headers that it uses in the same way, as an object with a `handle` function. The package then copies those headers for every route that the middleware applies to:

```ts
const requireLogin: Middleware = {
  headers: ['authorization'],
  handle: async (c, next) => {
    if (c.req.header('authorization') === undefined) return c.json({ error: 'Sign in first.' }, 401)
    await next()
  },
}
```

`c.req.header()` throws a `UhttpError` with the code `UNDECLARED_HEADER` for a header that nobody declared, so the first test that calls that code fails with the name of the missing header in its message. `c.req.clientAddress` throws `UNDECLARED_CLIENT_ADDRESS` in the same way when nobody declared the client address.

Set the body reader, the body limit, and the time limit of a route in the same options object, with `body`, `maxBodyBytes`, and `timeoutMs`, as [Request bodies and validation](bodies.md) describes.

A client can send some headers, such as `x-forwarded-for` and `cookie`, on several lines. For those list headers, the package collects every line and joins the lines into one value, with a semicolon and a space between cookie lines and a comma and a space between the lines of any other list header. For any other header, it copies the first line. For a route such as a proxy, pass `{ headers: 'all' }` to copy every header, and `c.req.headers()` then returns all of them.

## Stop work for a client that has gone

`c.req.signal` is an `AbortSignal` that fires when the client disconnects before the response ends, or when the handler passes the time limit of its route. The package creates the signal the first time that your code asks for it, so it creates signals only for the requests whose code uses one:

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

`app.request()` applies the checks that uWebSockets.js v20.71.0 applies to every request. It lowercases header names and trims the spaces around each value. It returns the same 400 as uWebSockets.js for more than 98 header lines and for an empty, repeated, or invalid `Host`. It returns that 400 too when the request line and the headers take more than 4,096 bytes, or more than `UWS_HTTP_MAX_HEADERS_SIZE` where you set it. When your headers include no `Host`, it sends `host: localhost`, as `fetch` does. Pass `clientAddress` to set the address that `c.req.clientAddress` returns, pass `signal` to test what happens when the client disconnects, and pass `body` to send a request body, which [Request bodies and validation](bodies.md) shows.
