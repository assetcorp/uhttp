# Errors

Every error that the package throws is a `UhttpError` with a `code`. Each code corresponds to one HTTP status. When your middleware or handler throws, the package turns the error into a reply with the shape `{ error: { code, message } }`. The middleware outside the throw then receives that reply after `await next()`.

```ts
import { createApp, UhttpError } from '@delali/uhttp'

const app = createApp().get('/users/:id', c => {
  const user = users.get(c.req.param('id') ?? '')
  if (user === undefined) throw new UhttpError('NOT_FOUND', 'No user has that id.')
  return c.json(user)
})
```

A client of that route receives this 404:

```json
{ "error": { "code": "NOT_FOUND", "message": "No user has that id." } }
```

## The codes

Match on the code, because the message can change between releases.

| Code | Status | When it appears |
| --- | --- | --- |
| `INVALID_PATH_PARAMETER` | 400 | A path parameter contains a percent sequence that fails to decode. |
| `NOT_FOUND` | 404 | A path has no route. You can throw it yourself for a missing record. |
| `METHOD_NOT_ALLOWED` | 405 | A path has routes, but none for the method of the request. |
| `INTERNAL_ERROR` | 500 | The client receives this code for every error that maps to 500. |
| `MISSING_REPLY` | 500 | The chain ends without a reply, or an error handler returns something other than a reply. |
| `NEXT_CALLED_TWICE` | 500 | A middleware calls `next()` a second time. |
| `UNDECLARED_HEADER` | 500 | Your code asks for a request header that neither the route nor its middleware declared. |
| `UNDECLARED_CLIENT_ADDRESS` | 500 | Your code asks for the client address, and nobody declared it. |
| `INVALID_HEADER` | 500 | Your code sets a header name that is not an HTTP token, or a value with a control character. |
| `INVALID_EVENT` | 500 | A server-sent event has a line break in its name or its ID, or a retry time that is not a whole number of zero or more. |
| `INVALID_STREAM` | 500 | Your producer writes more or fewer bytes than the length that you declared, or you pass a stream option outside its range. |
| `INVALID_STATUS` | 500 | You pass a helper a status that its reply can't have. |
| `INVALID_ROUTE` | 500 | You add a route path or a group prefix that the router can't match. |
| `INVALID_APP_OPTIONS` | 500 | You pass `createApp()` an option of the wrong type. |
| `INVALID_SERVE_OPTIONS` | 500 | You pass `serve()` a port outside 0 to 65535. |
| `LISTEN_FAILED` | 500 | The operating system can't bind the address that you chose. |

For a `UhttpError` below 500, the client receives its status, its code, and its message. For every other error, including any error that is not a `UhttpError`, the client receives a 500 whose message is 'The request failed.' alone, so a stack trace or an internal message stays on the server:

```json
{ "error": { "code": "INTERNAL_ERROR", "message": "The request failed." } }
```

## Errors at middleware boundaries

The package catches an error at the boundary of each middleware and makes the default error reply, or your error handler's reply, the current reply. The middleware outside the throw then resumes after `await next()` with that reply in `c.reply`, so a CORS middleware can still add its headers to a 500 and an access log can still record the status. The first call to `next()` therefore never rejects, while a second call rejects with `NEXT_CALLED_TWICE`.

A header that a middleware set with `c.header()` before the throw stays on the error reply. The CORS headers that a middleware sets before `await next()` therefore go out with a 4xx or a 5xx as well as with a 200.

## Replace the not-found and error handlers

Pass `notFound` and `onError` to `createApp()`:

```ts
const app = createApp({
  notFound: c => c.json({ title: 'Not Found', detail: `No route matches ${c.req.path}.` }, 404),
  onError: (error, c) => {
    if (error instanceof UhttpError && error.status < 500) {
      return c.json({ title: error.code, detail: error.message }, error.status)
    }
    return c.json({ title: 'Server Error' }, 500)
  },
})
```

The package calls `notFound` inside the app's middleware, so the middleware wraps your 404 as it wraps any other reply. When `onError` throws, rejects, or returns something other than a reply, the package logs that failure and sends the default reply for the original error.

## Log every 500

Pass a logger with pino's `info`, `warn`, and `error` methods, each of which takes an object and a message:

```ts
import pino from 'pino'

const app = createApp({ logger: pino() })
```

The package passes every error that leads to a 500 to `logger.error`, whatever reply your error handler sends. The entry has the error under `err`, together with the method and the path of the request. It leaves the query string out of the path, because a query string can contain a token. It logs the error even when the client has already gone. Without a logger, the package writes nothing.

When uWebSockets.js matches no route for a request and the JavaScript matcher matches one, the package serves that route and passes a warning to `logger.warn`, because any difference between the two matchers is a fault in the package.

## Errors that uWebSockets.js sends itself

uWebSockets.js rejects some malformed requests before it calls the package. For those requests, it sends an HTML body outside the JSON contract of the package. In v20.71.0, a client receives this 400 with `Connection: close` for a request with no `Host` header, an empty or repeated `Host`, more than 98 header lines, a request line and headers above 4,096 bytes, both `Content-Length` and `Transfer-Encoding`, or an HTTP/1.0 request line:

```html
<h1>Bad Request</h1><hr><i>uWebSockets/20 Server</i>
```

For headers that are too large, uWebSockets.js v20.71.0 sends that 400 in place of the 431 that [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585.html#section-5) defines, because its maintainers commented out the 431 in [the parser source](https://github.com/uNetworking/uWebSockets/blob/1d80f7a53816ef2433e89793b285b827f3efb2b2/src/HttpParser.h). Set `UWS_HTTP_MAX_HEADERS_SIZE` before uWebSockets.js loads to raise the limit of 4,096 bytes. A proxy in front of the server can turn these answers into JSON if your clients need one error format for every response.
