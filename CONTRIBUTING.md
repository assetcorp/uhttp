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
- `pnpm test:integration`, `pnpm test:e2e`, and `pnpm test:package` each test one of the three groups that the Tests section describes.
- `pnpm lint` checks the code with Biome.
- `pnpm typecheck` type-checks the TypeScript.
- `pnpm format` applies Biome formatting.
- `pnpm nx run uhttp:api:write` rewrites the API reports in `packages/ts/etc/`. Run it after you change an export, because the build fails until the committed reports match the exports.
- `pnpm nx run uhttp:speed` measures one route on uWebSockets.js on its own and on uhttp for 10 seconds each over 100 connections, and it fails when uhttp is more than 5% slower. It sends its requests with h2load from [nghttp2](https://github.com/nghttp2/nghttp2), so install h2load first with `brew install nghttp2` on macOS or `sudo apt-get install nghttp2-client` on Ubuntu. Close other busy programs before you run it, because on a busy machine the measured speed can differ by more than 10% between two runs.

The speed check needs a load generator that sends requests faster than the fastest server can answer them. When the load generator is the slower side, every server measures at the speed of the load generator, which hides the extra work that uhttp does. In a Linux container pinned the way the `Speed` workflow pins its processes, autocannon, a load generator written in JavaScript, reached about 320,000 requests a second against uWebSockets.js on its own, while h2load reached about 390,000. The check uses h2load because the nghttp2 project still releases it, Ubuntu packages it, and it counts every failed request.

On every PR, the `Speed` workflow measures three servers on one machine over 10 rounds with h2load: uWebSockets.js on its own, uhttp from main, and uhttp from the PR. It writes two tables to its summary. In the first table, the workflow compares uhttp before and after the PR, and it passes whatever the difference is. In the second table, it compares uhttp after the PR with uWebSockets.js on its own, and it fails when uhttp is more than 5% slower in the median round. Several PRs can each slow uhttp by less than the machine noise, so the workflow compares uhttp with uWebSockets.js on its own to catch their total. The `Speed comment` workflow then posts both tables as a comment on the PR and updates that comment after each push. When a PR upgrades uWebSockets.js, both servers in the second table run the new version, so read the first table to see what the upgrade changed.

## Tests

The tests of `packages/ts` are in `packages/ts/src/__tests__/`, in three groups. Vitest treats each group as a project of the same name and prints that name beside every test in its output.

- `integration/` contains the tests that send requests through `app.request()`, which passes each request through the real router, middleware, request context, and body parsers, without a socket or uWebSockets.js. Mirror the source directory that a test covers, as `integration/body/parsers.test.ts` does for `src/body/`.
- `e2e/` contains the tests that start the server with `serve()` and send requests to it on 127.0.0.1. Most of these tests use the client in `helpers/http-client.ts`, while a few use `fetch` or the HTTP client of Node.js through `helpers/node-client.ts`. The client in `helpers/http-client.ts` rejects any response that does not conform to HTTP/1.1. It also reports whether the server kept the connection open, closed it cleanly, or reset it. Name each file after the behaviour that a client sees, as `e2e/request-bodies.test.ts` does.
- `package/` contains the tests of the built files and of the manifest that npm publishes. One of them builds a bundle with Rollup for each middleware and fails when a bundle contains a middleware that the app of that bundle never imports.
- `helpers/` contains the helpers that the three groups share.
- `fixtures/` contains the app modules and the host scripts that a test starts in a worker thread or in a child process. For example, `fixtures/thread-host.ts` serves an app on worker threads, and it closes the server when the test sends `close` over IPC.

Write an end-to-end test for every behaviour that a client sees on the network, such as a status, a header, a closed connection, or a body that the client has to parse whole. `app.request()` never calls the code that writes to the socket, so only an end-to-end test can catch a fault in that code. In each end-to-end test, send the whole request that a real client would send, including the body of a request that the server rejects. Then check what happened to the connection after the response, as well as the response itself.

The static-file tests in `integration/middleware/static-case.test.ts` and `e2e/case-insensitive-static-files.test.ts` need a folder that ignores the case of file names. On macOS, the temporary folder of the system usually ignores case, so those tests use it. On Linux, set `UHTTP_CASE_INSENSITIVE_FOLDER` to such a folder, such as a FAT image that you mount, as the CI workflow does. Without that variable, Vitest skips those tests on Linux, while in CI the tests fail, so that CI never passes without them.

## Benchmarks

On [`BENCHMARKS.md`](BENCHMARKS.md), you can compare uhttp with uWebSockets.js on its own and with three other Node.js frameworks. A maintainer measures the servers for that page only when somebody asks for new figures, because the suite then keeps a quiet machine busy for about two hours, while it applies load to 30 server processes for 240 seconds each. To check that the suite works on your machine, start the smoke profile with `pnpm --dir benchmarks/suite bench:smoke`, in which the suite writes a smoke run that git ignores. You can find both profiles and every option of the suite in [`benchmarks/README.md`](benchmarks/README.md).

## Repository layout

- `packages/ts` contains the package that the publish workflow releases to npm as `@delali/uhttp`.
- `benchmarks` contains the benchmark suite and the generator that writes `BENCHMARKS.md`.
- `docs` contains the guides that the README links to.

## Conventions

- Keep each source file under 400 lines. When you split a module across several files, put them in a directory with an `index.ts` that re-exports the module.
- Let Biome format the code, and keep the layout that it writes.
- Write a TSDoc comment on every published export, and write no other comment anywhere.
- Give each optional middleware a directory under `packages/ts/src/middleware/` and an entry of its own in the `exports` map of `packages/ts/package.json`, and add it to the lists in `src/__tests__/package/tree-shaking.test.ts` and `src/__tests__/package/built-package.test.ts`, so that the tests check its entry in the `exports` map and check that a bundler can leave it out of an app that never imports it.
- Put every test in one of the three groups that the Tests section describes.

## Release

The `Publish` workflow publishes `@delali/uhttp` to npm through a trusted publisher, so the repository holds no npm token, and npm adds a provenance statement to every version that the workflow publishes.

On every push to main, the workflow publishes a prerelease under the `next` dist-tag once its lint, typecheck, build, and test jobs pass. The prerelease takes the next patch after the higher of the version in `packages/ts/package.json` and the newest version on npm, followed by `-next.<run number>.<run attempt>`, such as `0.4.2-next.57.1`. The workflow skips the prerelease when the commit already has a release tag, when main has moved past the commit, and when npm has no version of the package yet.

To cut a release, start the `Publish` workflow by hand on main, with `patch`, `minor`, `major`, or an exact version such as `1.2.3`. When you tick the dry run, the workflow goes through every step and prints the changes that a real release makes, but it makes no commit, no tag, no release, and no publish. The workflow first checks that main still points at the commit that it checked out, and it then repeats the lint, typecheck, build, and test jobs of a prerelease. Next, `nx release` writes the version into `packages/ts/package.json` and the entry into `packages/ts/CHANGELOG.md`, commits both files, and tags the commit `uhttp@v<version>`. It then pushes the commit and the tag and creates the GitHub release, after which `nx release publish` publishes the version under the `latest` dist-tag. The workflow pushes and creates the release with the `RELEASE_PAT` secret, which has to belong to an account that may push to main and create releases.

On npm, you add a trusted publisher in the settings of a package, so the package has to exist before the workflow can publish it. A maintainer therefore publishes the first version by hand:

1. Set the first version in `packages/ts/package.json` through a pull request, and merge it.
2. On that commit of main, install the dependencies with `pnpm install` and build the package with `pnpm nx run uhttp:build`. Then publish it with `npm publish` from `packages/ts` while you are signed in to npm.
3. Tag that commit `uhttp@v<version>`, push the tag, and create the GitHub release for it.
4. Add the trusted publisher with `npm trust github @delali/uhttp --file publish.yml --repo assetcorp/uhttp --allow-publish` from npm 12, which has the `npm trust` command.
5. Within 2 days, cut a release through the workflow, because a trusted publisher expires when nobody publishes through it within 2 days of its creation.

## Propose a change

- For a small first change, look for issues that carry the `good first issue` label.
- For a bug, open an issue with the bug template so that the report includes the version, the Node.js version, and a reproduction.
- For a larger change, open an issue to discuss the design before you write the code.

## Licence

By contributing, you agree that your contribution falls under the MIT licence that covers the project.
