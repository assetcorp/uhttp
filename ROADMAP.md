# Roadmap

uhttp is an HTTP and WebSocket server for Node.js on uWebSockets.js. It gives a developer the routes, the middleware, the body parsers, and the WebSocket handlers of a framework such as Express or Hono. It keeps the speed of uWebSockets.js because it copies what a route needs from the raw request before any asynchronous step and adds no work per request beyond that.

This roadmap lists the work that the project plans, so it will change as that work proceeds. It gives no dates. Open an issue to propose or discuss an item.

## Available now

- **The 0.1 release.** `@delali/uhttp` on npm holds the router, the middleware, the body parsers, file uploads, WebSocket routes, worker threads, and ten optional middleware, which the [Features](README.md#features) section of the README describes.
- **The benchmark page.** [BENCHMARKS.md](BENCHMARKS.md) compares the requests a second of uhttp with those of bare uWebSockets.js, Hono on its Node.js adapter, Fastify, and Express, and a generator writes its figures and charts from the newest recorded run.
- **An agent skill.** The skill under [`skills/uhttp/`](skills/uhttp/) tells a coding agent how to add uhttp to an app or move an app to it, in the way that the Narsil and Sirannon skills do. Install it with `npx skills add assetcorp/uhttp`.

## How to get involved

Read [CONTRIBUTING.md](CONTRIBUTING.md) to set up the repository, and look for issues that carry the `good first issue` label to make a first change.
