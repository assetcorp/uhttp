# Contributing to uhttp

This guide covers how to set up the repository, check a change, and propose it.

## Prerequisites

- You need Node.js 22.18 or a later 22 release, Node.js 24, or Node.js 26, because the repository's scripts are TypeScript files that those releases execute without a build step. The `.node-version` file contains 24.
- You need pnpm 11.8.0, the version in the `packageManager` field of `package.json`. Once you enable Corepack with `corepack enable`, Corepack uses that version whenever you call pnpm in this repository.

## Set up the repository

```bash
git clone https://github.com/assetcorp/uhttp.git
cd uhttp
pnpm install
```

## Check a change

Continuous integration applies the same checks, so apply them yourself before you open a pull request.

- `pnpm build` builds every package.
- `pnpm test` tests every package.
- `pnpm test:integration`, `pnpm test:e2e`, and `pnpm test:package` each run one group of the tests that the Tests section describes.
- `pnpm lint` checks the code with Biome.
- `pnpm typecheck` type-checks the TypeScript.
- `pnpm format` applies Biome formatting.
- `pnpm nx run uhttp:api:write` rewrites the API reports in `packages/ts/etc/`. Run it after you change an export, because the build fails until the committed reports match the exports.
- `pnpm nx run uhttp:speed` measures one route on bare uWebSockets.js and on uhttp for 10 seconds each at 100 connections, and it fails when uhttp is more than 10% slower. Close other busy programs first, because on a busy machine the result can vary by more than 10% in either direction.

On every pull request, the `Speed` workflow compares the speed of the change with main and writes a table to its summary. The `Speed comment` workflow then posts that table as a comment on the pull request, and it updates the same comment after each push. The workflow passes whatever the table contains.

## Tests

The tests of `packages/ts` are in `packages/ts/src/__tests__/`, in three groups. Vitest runs each group as a project of the same name, so every line of its output shows which group the test belongs to.

- `integration/` holds the tests that send requests through `app.request()`. Those requests go through the real router, middleware, request context, and body parsers, but no socket and no uWebSockets.js take part. Mirror the source directory that a test covers, as `integration/body/parsers.test.ts` does for `src/body/`.
- `e2e/` holds the tests that start the server with `serve()` and send requests to it on 127.0.0.1. Most of these tests use the client in `helpers/http-client.ts`, while the rest use `fetch`. That client rejects any response that breaks HTTP/1.1, and it reports whether the server kept the connection open, closed it cleanly, or reset it. Name each file after the behaviour that a client sees, as `e2e/request-bodies.test.ts` does.
- `package/` holds the tests of the built files and of the manifest that npm publishes.
- `helpers/` holds the helpers that the three groups share.

Write an end-to-end test for every behaviour that a client sees on the network, such as a status, a header, a closed connection, or a body that the client has to parse whole. `app.request()` never runs the code that writes to the socket, so a fault in that code shows up only in an end-to-end test. In each end-to-end test, send the whole request that a real client would send, including the body of a request that the server rejects. Then check what happened to the connection after the response, as well as the response itself.

## Repository layout

- `packages/ts` holds the package that the publish workflow releases to npm as `@delali/uhttp`.
- `benchmarks` holds the benchmark suite and the generator that writes `BENCHMARKS.md`.
- `docs` holds the guides that the README links to.

## Conventions

- Keep each source file under 400 lines. When you split a module across several files, put them in a directory with an `index.ts` that re-exports the module.
- Let Biome format the code, and keep the layout that it writes.
- Write a TSDoc comment on every published export, and write no other comment anywhere.
- Put every test in one of the three groups that the Tests section describes.

## Propose a change

- For a small first change, look for issues that carry the `good first issue` label.
- For a bug, open an issue with the bug template so that the report includes the version, the Node.js version, and a reproduction.
- For a larger change, open an issue to discuss the design before you write the code.

## Licence

By contributing, you agree that your contribution falls under the MIT licence that covers the project.
