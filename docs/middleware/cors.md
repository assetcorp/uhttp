# CORS

A browser lets a script read the response to a cross-origin request only when the server names the origin of that script, or `*`, in `Access-Control-Allow-Origin`. The middleware that `cors()` returns adds that header and the other CORS headers for the origins that you list. It also returns a 204 for the preflight request that a browser sends before a request that a form can't send, such as a `PUT` or a JSON `POST`.

```ts
import { createApp } from '@delali/uhttp'
import { cors } from '@delali/uhttp/cors'

const app = createApp()
  .use(cors({ origin: 'https://shop.example' }))
  .get('/products', c => c.json(products))
  .put('/cart', async c => c.json(await saveCart(c)))
```

Add `cors()` to the app with `app.use()`. The package also calls the middleware of the app for a path that has no route, so the middleware can return a 204 for a preflight to any path, including a path with no OPTIONS route.

## Name the origins

Set the `origin` option in one of four forms:

- With one origin, such as `https://shop.example`, the middleware sends that origin on every response.
- With `*`, the middleware allows every origin, so use it only for a public API that needs no cookie.
- With a list of origins, the middleware sends back the origin of the request when the list includes it.
- With a function, the middleware calls the function with the origin and the context, and it allows the origin when the function returns `true`. The function can be async.

Write each origin as a browser sends it, with the scheme, the host, any port other than the default, no path, and no trailing slash. `cors()` throws `INVALID_MIDDLEWARE_OPTIONS` for any other spelling, so `cors()` throws at startup for a typo such as `https://shop.example/`. The middleware checks that an origin from a request is well formed before it calls your function, so the function can compare the text as it is:

```ts
const partners = new Set(['https://shop.example', 'https://partner.example'])

app.use(cors({ origin: origin => partners.has(origin) || origin.endsWith('.shop.example') }))
```

With a list or a function, the middleware adds no CORS header to the response for an origin that you don't allow, so the browser keeps the response from the script. With one fixed origin, the middleware sends that origin on every response. A browser then keeps the response from a script on any other origin, because the origin of that script differs from the origin in the header.

## Caches and Vary

For `*` or one fixed origin, the middleware sends the same CORS headers on every response, without `Vary`, so that a cache can share one copy of the response between all clients. For a list or a function, the middleware sets `Access-Control-Allow-Origin` according to the origin of the request, so it adds `Vary: Origin` to every response, and a cache then keeps a separate copy for each origin.

## Preflight requests

A preflight request is an OPTIONS request with `Origin` and `Access-Control-Request-Method`. For a preflight from an allowed origin, the middleware returns a 204 with these headers:

| Header | Value |
| --- | --- |
| `Access-Control-Allow-Methods` | The middleware sends the `methods` option, which is `GET, HEAD, PUT, POST, DELETE, PATCH` by default. |
| `Access-Control-Allow-Headers` | The middleware sends the `allowHeaders` option. Without that option, the middleware allows the headers that the browser lists in `Access-Control-Request-Headers`, up to 1,024 characters of valid header names, and it adds `Vary: Access-Control-Request-Headers`. |
| `Access-Control-Max-Age` | The middleware sends the `maxAge` option, which is 600 seconds by default and 86,400 at most, so that the browser caches the result of the preflight for that long. |

The middleware passes a preflight from an origin that you don't allow on to your routes, so the package replies to it as to any other OPTIONS request. With one fixed origin, the middleware passes on a preflight from every other origin in the same way.

## Cookies and credentials

Pass `credentials: true` when the browser sends cookies with the cross-origin requests of your site, so that the middleware adds `Access-Control-Allow-Credentials: true`. `cors()` throws `INVALID_MIDDLEWARE_OPTIONS` when you pass `credentials: true` with `*` or with `null`, because a browser rejects a credentialed response that allows `*`, while any page can send the origin `null`, from a sandboxed frame for example:

```ts
app.use(cors({ origin: ['https://shop.example', 'https://admin.shop.example'], credentials: true }))
```

Pass `exposeHeaders` to let a script read response headers beyond the ones that every browser exposes, such as `X-Request-Id`.

With CORS, the server chooses which scripts can read a response, while a browser sends a cross-origin form and its cookies without a preflight. Add [`csrf()`](csrf.md) to reject a cross-site form that changes data.
