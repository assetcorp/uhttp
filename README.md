# uhttp

uhttp is an HTTP and WebSocket server for Node.js on top of uWebSockets.js. It gives you the routes, the middleware such as a login check, the body parsers for JSON and for file uploads, the response helpers, and the WebSocket routes that Express or Hono give you. Underneath, the server keeps the speed of uWebSockets.js, because it copies what a route needs from the raw request before any asynchronous step and adds no work per request beyond that.

The package is under construction and has no release yet. The first release will go to npm as `@delali/uhttp`, with the parts that [ROADMAP.md](ROADMAP.md) lists.

## Guides

- Read [Routing and middleware](docs/routing.md) for routes, path parameters, groups, middleware, the request context, and testing without a port.
- Read [Responses](docs/responses.md) for the reply helpers, response headers, streamed responses, and server-sent events.
- Read [Errors](docs/errors.md) for the error codes, the error and not-found handlers, the logger, and the errors that uWebSockets.js sends itself.

## License

MIT
