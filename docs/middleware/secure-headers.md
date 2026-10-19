# Security headers

The middleware that `secureHeaders()` returns adds response headers, so that a browser blocks framing by other sites, content sniffing, and other behaviour that an attacker can abuse. When you add it with `app.use()`, the middleware adds the headers to every response, including a 404, a 500, and the 503 that the package sends when a handler passes its time limit.

```ts
import { createApp } from '@delali/uhttp'
import { secureHeaders } from '@delali/uhttp/secure-headers'

const app = createApp()
  .use(secureHeaders())
  .get('/', c => c.text('Welcome to the shop'))
```

## The presets

Use the `web` preset, which is the default, for pages that a browser renders. With it, the middleware sends these headers:

| Header | Value |
| --- | --- |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Origin-Agent-Cluster` | `?1` |
| `Referrer-Policy` | `no-referrer` |
| `X-Content-Type-Options` | `nosniff` |
| `X-DNS-Prefetch-Control` | `off` |
| `X-Download-Options` | `noopen` |
| `X-Frame-Options` | `SAMEORIGIN` |
| `X-Permitted-Cross-Domain-Policies` | `none` |
| `X-XSS-Protection` | `0` |

With the `api` preset, the middleware sends the headers that OWASP recommends for API responses in its [REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html), together with the `Referrer-Policy` that OWASP recommends there for an API that can return HTML:

| Header | Value |
| --- | --- |
| `Cache-Control` | `no-store` |
| `Content-Security-Policy` | `frame-ancestors 'none'` |
| `Referrer-Policy` | `no-referrer` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |

With either preset, the middleware also sends `Strict-Transport-Security: max-age=15552000; includeSubDomains`, so that a browser uses HTTPS for the site and its subdomains for the next 180 days. The middleware sends that header only on a TLS connection, or when a proxy that `trustedProxies()` trusts reports `https`, because a browser ignores the header on a response over plain HTTP. The middleware reads the protocol before the handler, so add `trustedProxies()` before `secureHeaders()`, and read [Trusted proxies](trusted-proxies.md) to learn how the package finds the protocol behind a proxy.

## Change a header

Name a header in `headers` with a new value to change it, with `false` to switch it off, or with a value to add a header that is missing from the preset. The package matches the names without regard to case:

```ts
app.use(
  secureHeaders({
    preset: 'web',
    headers: {
      'X-Frame-Options': 'DENY',
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
      'X-Download-Options': false,
      'Permissions-Policy': 'camera=(), microphone=()',
    },
  }),
)
```

The middleware checks and encodes every header once, when you call `secureHeaders()`, so it does none of that work on each request. On a 200 with a text or JSON body, the package writes the fixed headers of the outermost `secureHeaders()` in the same call to uWebSockets.js as the status line, unless your code or an inner `secureHeaders()` sets one of them, so the package makes no extra call for those headers. `secureHeaders()` throws `INVALID_MIDDLEWARE_OPTIONS` for a name that is not an HTTP token, for a value with a control character, or for a framing header such as `Content-Length`.

When your handler or any other middleware sets one of the headers itself, the package sends that value in place of the value of `secureHeaders()`. When two `secureHeaders()` middleware set the same header, the package sends the value of the inner one, such as the one on the route. You can therefore send `Cross-Origin-Resource-Policy: cross-origin` from a route that serves a file for other sites to embed, such as a badge:

```ts
app.get('/badge.svg', c =>
  c.text(badge, 200, { 'content-type': 'image/svg+xml', 'cross-origin-resource-policy': 'cross-origin' }),
)
```

## A policy with a nonce

When a `Content-Security-Policy` contains a nonce, a browser executes only the inline scripts whose `nonce` attribute matches it. When you pass `contentSecurityPolicy` as a function, the middleware generates 16 random bytes for each request and calls the function with those bytes in base64. It then sends the policy that the function returns. Read the nonce with `nonceOf(c)` to put it on your scripts:

```ts
import { nonceOf, secureHeaders } from '@delali/uhttp/secure-headers'

const app = createApp()
  .use(secureHeaders({ contentSecurityPolicy: nonce => `script-src 'nonce-${nonce}'; object-src 'none'` }))
  .get('/', c => c.text(`<script nonce="${nonceOf(c)}">startShop()</script>`, 200, { 'content-type': 'text/html' }))
```

`nonceOf(c)` returns `undefined` when you put no `secureHeaders()` with a policy function in front of the route. `secureHeaders()` throws `INVALID_MIDDLEWARE_OPTIONS` when you pass both a policy function and a fixed `Content-Security-Policy` in `headers`, because the middleware can send only one of the two.
