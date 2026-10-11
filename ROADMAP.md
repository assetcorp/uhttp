# Roadmap

uhttp is an HTTP and WebSocket server for Node.js on uWebSockets.js. It gives a developer the routes, the middleware, the body parsers, and the WebSocket handlers of a framework such as Express or Hono. It keeps the speed of uWebSockets.js because it copies what a route needs from the raw request before any asynchronous step and adds no work per request beyond that.

This roadmap lists the work that the project plans, so it will change as that work proceeds. It gives no dates. Open an issue to propose or discuss an item.

## In progress

- **The first release.** The first version of `@delali/uhttp` will hold the parts that the list below names.
  - The router will match a path with parameters.
  - Middleware will apply to the whole app, to a group, or to one route.
  - The server will copy what a route needs from the raw request into a request context before any asynchronous step.
  - A handler will read the body as a stream, or through a JSON, text, bytes, form, or multipart parser, under a limit that each route sets.
  - A file upload will stream to a destination of the caller's choice.
  - A response will include every security header by default, with each header configurable.
  - A WebSocket route will pass through the same middleware as an HTTP route.
  - One `threads` option will spread connections across worker threads.
  - Any Standard Schema validator will check request data.
  - A logger will be optional.
- **The benchmark page.** A suite will send requests with h2load to bare uWebSockets.js, uhttp, Hono on its Node.js adapter, Fastify, and Express, over a plain route, a JSON route, and an upload route, across a sweep of connection counts. A generator will then write the figures and the charts into `BENCHMARKS.md` from the recorded results.

## Planned

- **An agent skill.** A skill under `skills/uhttp/` will tell a coding agent how to add the server to an app, in the way that the Narsil and Sirannon skills do.

## How to get involved

Read [CONTRIBUTING.md](CONTRIBUTING.md) to set up the repository, and look for issues that carry the `good first issue` label to make a first change.
