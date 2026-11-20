# The ten optional middleware

Each optional middleware has a separate entry point, so a bundler leaves out every middleware that the app never imports. Add them with `app.use()` in the order of this table, because each middleware after `trustedProxies()` takes the address, the protocol, and the host of the client from it:

| Entry point | Function | What it does |
| --- | --- | --- |
| `@delali/uhttp/trusted-proxies` | `trustedProxies({ trust })` | Takes the client address, the protocol, and the host from the `X-Forwarded-*` headers of the proxies in `trust` |
| `@delali/uhttp/request-id` | `requestId()` | Sends an ID for each request in `X-Request-Id` |
| `@delali/uhttp/access-log` | `accessLog({ write })` | Writes one line for each request |
| `@delali/uhttp/secure-headers` | `secureHeaders({ preset, headers, contentSecurityPolicy })` | Adds the security headers that a browser checks |
| `@delali/uhttp/cors` | `cors({ origin, credentials })` | Adds the CORS headers for the origins that you list, and answers preflight requests |
| `@delali/uhttp/csrf` | `csrf({ origin })` | Answers 403 to a form that a page on another site sends |
| `@delali/uhttp/rate-limit` | `rateLimit({ limit, windowMs })` | Answers 429 once a client passes the limit in one window |
| `@delali/uhttp/cookies` | `cookies({ keys })` | Declares the `Cookie` header and holds the keys that sign cookies |
| `@delali/uhttp/compression` | `compression()` | Compresses text and JSON with Brotli, zstd, or gzip |
| `@delali/uhttp/static` | `serveStatic({ root, prefix })` | Serves the files in a folder for GET and HEAD requests |

```ts
import { mkdirSync } from 'node:fs'
import { createApp, serve } from '@delali/uhttp'
import { accessLog } from '@delali/uhttp/access-log'
import { compression } from '@delali/uhttp/compression'
import { cookies, getSignedCookie, setSignedCookie } from '@delali/uhttp/cookies'
import { cors } from '@delali/uhttp/cors'
import { csrf } from '@delali/uhttp/csrf'
import { rateLimit } from '@delali/uhttp/rate-limit'
import { requestId } from '@delali/uhttp/request-id'
import { secureHeaders } from '@delali/uhttp/secure-headers'
import { serveStatic } from '@delali/uhttp/static'
import { trustedProxies } from '@delali/uhttp/trusted-proxies'

const COOKIE_KEY_MIN_LENGTH = 32
const cookieKey = process.env.COOKIE_KEY
if (cookieKey === undefined || cookieKey.length < COOKIE_KEY_MIN_LENGTH) {
  throw new Error(`Set COOKIE_KEY to at least ${COOKIE_KEY_MIN_LENGTH} random characters.`)
}

const SHOP_ORIGIN = 'https://shop.example.com'
mkdirSync('./public', { recursive: true })

const app = createApp({ logger: console })
  .use(trustedProxies({ trust: ['127.0.0.1'] }))
  .use(requestId())
  .use(accessLog())
  .use(secureHeaders({ preset: 'api' }))
  .use(cors({ origin: [SHOP_ORIGIN], credentials: true }))
  .use(csrf({ origin: [SHOP_ORIGIN] }))
  .use(rateLimit({ limit: 100, windowMs: 60_000 }))
  .use(cookies({ keys: [cookieKey] }))
  .use(compression())
  .use(serveStatic({ root: './public', prefix: '/assets' }))
  .post('/sessions', c => {
    setSignedCookie(c, 'session', 'acc_1', { maxAge: 7 * 24 * 60 * 60 })
    return c.json({ signedIn: true }, 201)
  })
  .get('/me', c => c.json({ account: getSignedCookie(c, 'session') ?? null }))

await serve({ app, port: 3000, host: '127.0.0.1' })
```

## What to know about each one

- **Trusted proxies.** `trust` is empty by default, and it takes addresses, CIDR ranges such as `10.0.0.0/8`, and the word `unix`. It throws `INVALID_MIDDLEWARE_OPTIONS` for a hop count or `true`, because a client can add entries to `X-Forwarded-For`. Read the results with `clientAddressOf(c)`, `protocolOf(c)`, and `hostOf(c)`, and declare the `host` header on a route that calls `hostOf(c)` without a proxy.
- **Request IDs.** `requestIdOf(c)` returns the ID. The middleware keeps an inbound `X-Request-Id` only from a proxy that `trustedProxies()` trusts, and it generates a new ID with `crypto.randomUUID()` for every other request.
- **Access logs.** Each line holds the method, the route template, the status, the duration, the client address, and the request ID. The line leaves out the path, the query string, the headers, and the cookies, because they can hold a token or a session. Without `write`, the lines go to standard output.
- **Security headers.** Use the `web` preset, the default, for pages, and the `api` preset for JSON. The middleware sends `Strict-Transport-Security` only on a TLS connection, or when a trusted proxy reports `https`. A function in `contentSecurityPolicy` receives a nonce for each request, and `nonceOf(c)` returns it for the `nonce` attribute of each inline script.
- **CORS.** Spell each origin as a browser sends it, with no path and no trailing slash, because `cors()` throws `INVALID_MIDDLEWARE_OPTIONS` for any other spelling. It also throws for `credentials: true` with `'*'`. Add `cors()` with `app.use()`, so that it answers a preflight to every path.
- **CSRF protection.** The middleware checks each request other than GET, HEAD, OPTIONS, and TRACE whose content type a form can send, and lets JSON through, since a browser sends JSON to another origin only after a CORS preflight. With `origin`, include the origin of the app itself, because the middleware then checks a browser that sends no `Sec-Fetch-Site` against that list alone.
- **Rate limits.** The built-in store counts the requests of each client address, with every IPv6 address of one /64 as one client, and every worker thread shares those counts. Build each rate limiter once, when the module loads. Pass `key` and `headers` to count by another value, such as an API key header, and pass a `store` with an `increment` method to share the counts across servers through Redis.
- **Cookies.** Add `cookies()` to every route that reads a cookie, because `getCookie()` on a route without it fails with a 500, which the logger records as `UNDECLARED_HEADER`. `setCookie()` sets `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/` unless you change them. Each key holds at least 20 bytes, and the first key signs new cookies while every key verifies them, so put a new key first to rotate keys. Safari drops a `Secure` cookie from `http://localhost`, so serve HTTPS on the machine, or pass `secure: false` in development alone.
- **Compression.** The middleware compresses a body of 1,024 bytes or more. Call `skipCompression(c)` on a route whose reply holds a secret, such as a CSRF token, next to text from the request, because the size of the compressed reply can reveal that secret one character at a time. Leave `compression()` out when a CDN or a load balancer compresses the replies.
- **Static files.** `serveStatic()` throws `INVALID_MIDDLEWARE_OPTIONS` when the folder is missing, so create it first. The middleware answers 404 to a path that differs from its canonical spelling, such as `/assets/%2E%2E/secret.txt`, and serves only regular files inside the folder. Set `cacheControl: 'public, max-age=31536000, immutable'` for files whose names change with each build.
