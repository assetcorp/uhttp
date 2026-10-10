# Errors

Every error that the package throws is a `UhttpError` with a `code`. Each code corresponds to one HTTP status. When your middleware or handler throws, the package turns the error into a reply with the shape `{ error: { code, message } }`. In the middleware outside the throw, `c.reply` is that error reply once `await next()` returns.

```ts
import { createApp, UhttpError } from '@delali/uhttp'

const app = createApp().get('/users/:id', c => {
  const user = users.get(c.req.param('id') ?? '')
  if (user === undefined) throw new UhttpError('NOT_FOUND', 'No user has that id.')
  return c.json(user)
})
```

For an unknown id, the package sends this 404:

```json
{ "error": { "code": "NOT_FOUND", "message": "No user has that id." } }
```

## The codes

Match on the code, because the message can change between releases.

| Code | Status | When the package throws it |
| --- | --- | --- |
| `INVALID_PATH_PARAMETER` | 400 | A path parameter contains a percent sequence that fails to decode. |
| `NOT_FOUND` | 404 | A path has no route. You can throw it yourself for a missing record. |
| `METHOD_NOT_ALLOWED` | 405 | A path has routes, but none for the method of the request. |
| `PAYLOAD_TOO_LARGE` | 413 | A request body, a form, or an upload passes one of its limits. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | A body parser receives a content type or a charset that it can't parse, or the client compresses a request body. |
| `INVALID_JSON` | 400 | A JSON body fails to parse, or it contains a `__proto__` key or a `constructor` key with a `prototype` key. |
| `VALIDATION_FAILED` | 400 | A JSON body fails its schema. The package lists the first 10 problems under `issues`. |
| `INVALID_MULTIPART` | 400 | A multipart body has an invalid boundary, a part without a name, a control character in a name or a filename, or no closing boundary. |
| `REQUEST_ABORTED` | 400 | The client disconnects before the body ends, so a pending read of the body rejects with this code. Only your code sees this error, because the client has gone or the response has ended. |
| `HANDLER_TIMEOUT` | 503 | A handler passes the time limit of its route. |
| `INTERNAL_ERROR` | 500 | The package sends this code to the client for every error that maps to 500. |
| `MISSING_REPLY` | 500 | The middleware chain ends without a reply, or an error handler returns something other than a reply. |
| `NEXT_CALLED_TWICE` | 500 | A middleware calls `next()` a second time. |
| `UNDECLARED_HEADER` | 500 | Your code asks for a request header that neither the route nor its middleware declared. |
| `UNDECLARED_CLIENT_ADDRESS` | 500 | Your code asks for the client address, and nobody declared it. |
| `UNDECLARED_BODY` | 500 | Your code reads the body on a route without a body reader. |
| `BODY_ALREADY_READ` | 500 | Your code reads a body after it streamed that body. |
| `INVALID_SCHEMA` | 500 | A schema lacks the Standard Schema interface, or its validator throws, rejects, or returns something other than a Standard Schema result. |
| `INVALID_UPLOAD` | 500 | You pass `multipart()` a limit that is not a whole number of zero or more, its `file` callback returns something other than a writable stream, or a destination closes before the package has written the whole file. |
| `INVALID_HEADER` | 500 | Your code sets a header name that is not an HTTP token, or a value with a control character. |
| `INVALID_EVENT` | 500 | A server-sent event has a line break in its name or its ID, or a retry time that is not a whole number of zero or more. |
| `INVALID_STREAM` | 500 | Your producer writes more or fewer bytes than the length that you declared, or you pass a stream option outside its range. |
| `INVALID_STATUS` | 500 | You pass a helper a status outside the range that its reply allows. |
| `INVALID_ROUTE` | 500 | You add a route path or a group prefix that breaks the rules of the router, or a route option of the wrong type. |
| `INVALID_APP_OPTIONS` | 500 | You pass `createApp()` an option of the wrong type, or a limit that is not a whole number of zero or more. |
| `INVALID_SERVE_OPTIONS` | 500 | You pass `serve()` a port outside 0 to 65535. |
| `LISTEN_FAILED` | 500 | The operating system returns an error when the package binds the address that you chose. |

For a `UhttpError` below 500, and for `HANDLER_TIMEOUT`, the package sends the status, the code, and the message of the error, together with `issues` for `VALIDATION_FAILED`. For every other error, including any error that is not a `UhttpError`, it sends a 500 whose message is 'The request failed.' alone, so that the package writes a stack trace or an internal message only to your logger:

```json
{ "error": { "code": "INTERNAL_ERROR", "message": "The request failed." } }
```

## Errors at middleware boundaries

The package catches an error at the boundary of each middleware and makes the default error reply, or the reply of your error handler, the current reply. The middleware outside the throw then continues after `await next()` with that reply in `c.reply`, so a CORS middleware can add its headers to a 500 and an access log can record the status. The first call to `next()` therefore always resolves, while a second call rejects with `NEXT_CALLED_TWICE`.

The package sends the headers that a middleware set with `c.header()` before the throw together with the error reply. It therefore sends the CORS headers that a middleware sets before `await next()` with a 4xx or a 5xx as well as with a 200.

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

The package calls `notFound` inside the app's middleware, so it calls the middleware around your 404 as it does around any other reply. When `onError` throws, rejects, or returns something other than a reply, the package logs that failure and sends the default reply for the original error.

## Log every 500

Pass a logger with pino's `info`, `warn`, and `error` methods, each of which takes an object and a message:

```ts
import pino from 'pino'

const app = createApp({ logger: pino() })
```

The package passes every error that leads to a 500 to `logger.error`, whatever reply your error handler sends. In each entry, the package puts the error under `err`, together with the method and the path of the request. It leaves the query string out of the path, because a query string can contain a token. It logs the error even when the client has already gone. The package writes log entries only to the logger that you pass.

When uWebSockets.js matches no route for a request and the JavaScript matcher matches one, the package serves that route and passes a warning to `logger.warn`, because any difference between the two matchers is a fault in the package.

## Errors that uWebSockets.js sends itself

For some malformed requests, uWebSockets.js sends a 400 itself, before it calls the package. That 400 has an HTML body, outside the JSON contract of the package. uWebSockets.js v20.71.0 sends this 400 with `Connection: close` for a request with no `Host` header, an empty or repeated `Host`, more than 98 header lines, a request line and headers above 4,096 bytes, both `Content-Length` and `Transfer-Encoding`, or an HTTP/1.0 request line:

```html
<h1>Bad Request</h1><hr><i>uWebSockets/20 Server</i>
```

For headers that are too large, uWebSockets.js v20.71.0 sends that 400 in place of the 431 that [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585.html#section-5) defines, because its maintainers commented out the 431 in [the parser source](https://github.com/uNetworking/uWebSockets/blob/1d80f7a53816ef2433e89793b285b827f3efb2b2/src/HttpParser.h). Set `UWS_HTTP_MAX_HEADERS_SIZE` before uWebSockets.js loads to raise the limit of 4,096 bytes. A proxy in front of the server can replace these HTML bodies with JSON when your clients need one error format for every response.
