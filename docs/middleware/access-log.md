# Access logs

The middleware that `accessLog()` returns writes one line for each request once the package sends the response or the client disconnects. Each line consists of the method, the route template, the status, the duration in milliseconds, the client address, and the request ID, separated by spaces:

```
GET /users/:id 200 1.4ms 203.0.113.9 9b2f6a4e-3c1d-4e8f-a0b2-7d5c9e1f3a64
```

```ts
import { createApp } from '@delali/uhttp'
import { accessLog } from '@delali/uhttp/access-log'
import { requestId } from '@delali/uhttp/request-id'
import { trustedProxies } from '@delali/uhttp/trusted-proxies'

const app = createApp()
  .use(trustedProxies({ trust: ['10.0.0.0/8'] }))
  .use(requestId())
  .use(accessLog())
```

By default, the middleware writes each line and a line break to standard output. Pass `write` to send each line somewhere else, such as to your logger, in which case the middleware passes the line without a line break:

```ts
app.use(accessLog({ write: line => logger.info(line) }))
```

## The fields

The middleware measures the duration from the moment that it starts on the request until the package sends the response or the client disconnects. It writes `-` for a field that has no value for the request. The route of a 404 is `-`, because the router matched no route, and the status is `-` when the client disconnected before the handler returned a reply:

```
GET - 404 0.2ms 198.51.100.4 1c7e2d90-5b4a-4f3e-9d8c-6a1b0e2f4c37
GET /reports/:id - 30012.5ms 198.51.100.4 7d3f9a12-8e6b-4c5d-b1a0-2f9e8d7c6b54
```

The client address is the one that `clientAddressOf()` returns, so add `trustedProxies()` before `accessLog()` when your app serves requests behind a proxy. Otherwise, the middleware will write the address of the proxy on every line. The middleware takes the request ID from `requestId()`, which you can add anywhere in the same chain, because the middleware writes the line after the package has sent the response. Without `requestId()`, the ID is `-`.

## What the line leaves out

The middleware writes the route template, such as `/users/:id`, and leaves the path, the query string, the headers, and the cookies out of the line, because a path or a query string can contain a token, while the headers and the cookies can contain a session. The middleware writes every control character, backslash, and Unicode line separator as a `\x` or `\u` escape, so that each request produces exactly one line, whatever bytes the client sends. It also cuts each line to 2,048 characters.

When your `write` function throws, the package drops that line and passes the error to `logger.error` of the app. The package has sent the response by then, so the failure leaves the reply unchanged.
