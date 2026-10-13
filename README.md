# uhttp

uhttp is an HTTP and WebSocket server for Node.js on uWebSockets.js. With it, you can write routes, middleware such as a login check, body parsers for JSON and for file uploads, replies through helpers, and WebSocket routes. Before any asynchronous step, the package copies only the parts of the raw request that the code of a route reads, which is why uhttp serves requests nearly as fast as uWebSockets.js on its own. A speed check on every pull request fails when uhttp serves requests more than 5% more slowly than uWebSockets.js on its own.

The package is under construction and has no release yet. The first release will go to npm as `@delali/uhttp`, with the parts that [ROADMAP.md](ROADMAP.md) lists.

## Guides

- Read [Routing and middleware](docs/routing.md) for routes, path parameters, groups, middleware, the request context, and testing without a port.
- Read [Request bodies and validation](docs/bodies.md) for the body parsers, Standard Schema validation, body limits, and time limits.
- Read [Uploads](docs/uploads.md) for multipart forms, streaming each file to a destination, and the limits of an upload.
- Read [Responses](docs/responses.md) for the reply helpers, response headers, streamed responses, and server-sent events.
- Read [WebSockets](docs/websockets.md) for WebSocket routes, the upgrade through middleware, the origin check, the limits of a socket, and pub/sub across threads and servers.
- Read [Worker threads](docs/threads.md) for serving on several threads, the memory of each worker, and what happens when a worker crashes or hangs.
- Read [Start and stop a server](docs/start-and-stop.md) for ports, Unix sockets, closing without dropping a request, and closing on a signal.
- Read [Serve HTTPS](docs/https.md) for certificates, several hostnames, and renewing certificates while the server serves.
- Read [Errors](docs/errors.md) for the error codes, the error and not-found handlers, the logger, and the errors that uWebSockets.js sends itself.

## License

MIT
