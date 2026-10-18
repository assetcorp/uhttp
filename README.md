# uhttp

uhttp is an HTTP and WebSocket server for Node.js on uWebSockets.js. With it, you can add routes and WebSocket routes, put middleware such as a login check in front of them, parse JSON bodies and file uploads, and build replies with helpers. Before any asynchronous step, the package copies only the parts of the raw request that the code of a route uses, so that uhttp can serve requests nearly as fast as uWebSockets.js on its own. The speed check on every pull request fails when uhttp serves requests more than 5% more slowly than uWebSockets.js on its own.

The package is under construction and has no release yet. The first release will go to npm as `@delali/uhttp`, with the parts in [ROADMAP.md](ROADMAP.md).

## Guides

- Read [Routing and middleware](docs/routing.md) for routes, path parameters, groups, middleware, the request context, and testing without a port.
- Read [Request bodies and validation](docs/bodies.md) for the body parsers, Standard Schema validation, body limits, and time limits.
- Read [Uploads](docs/uploads.md) for multipart forms, streaming each file to a destination, and the limits of an upload.
- Read [Responses](docs/responses.md) for the reply helpers, response headers, streamed responses, and server-sent events.
- Read [WebSockets](docs/websockets.md) for WebSocket routes, the upgrade through middleware, the origin check, the limits of a socket, and pub/sub across threads and servers.
- Read [Worker threads](docs/threads.md) for serving on several threads, the memory of each worker, and what happens when a worker crashes or hangs.
- Read [Start and stop a server](docs/start-and-stop.md) for ports, Unix sockets, a close that drops no request, and a close on a signal.
- Read [Serve HTTPS](docs/https.md) for certificates, several hostnames, and the renewal of certificates while the server goes on serving.
- Read [Errors](docs/errors.md) for the error codes, the error and not-found handlers, the logger, and the errors that uWebSockets.js sends itself.

## License

MIT
