# Working in this repository

This repository holds uhttp, an HTTP and WebSocket server for Node.js on uWebSockets.js, which the publish workflow releases to npm as `@delali/uhttp` from `packages/ts`.

Read the file that you're editing and follow what it already does. The rules below cover what that reading leaves out.

## Rules

- Re-read and apply the developer's writing guidelines fully, if available, whenever you write TSDoc or any prose in the repository.
- Keep every source file under 400 lines. Measure a file when you touch it, and split it before your change pushes it over. Turn a module that outgrows one file into a directory with an `index.ts` that re-exports it, and drop the module prefix from each file name inside.
- Put every tuning value, meaning a threshold, an interval, a size, or a retry budget, in its directory's `constants.ts`. Name a constant `DEFAULT_X` where an option overrides it, `MAX_X` or `MIN_X` where the server throws beyond it, and a plain name where nothing overrides it, ending a duration in `_MS` and a size in `_BYTES`. A `constants.ts` holds literals alone and imports nothing at runtime beyond another `constants.ts`, so that a bundler can drop what a caller never imports. A `constants.ts` may exceed 400 lines.
- Keep everything tree-shakeable. A bundler must be able to drop any capability that the caller never imports, so add no barrel that pulls siblings in, and register no optional capability at module load.
- Throw a typed error that holds a code from the error module, and let it propagate unchanged, because its code is what the server maps to an HTTP status.
- Read the uWebSockets.js request object inside the synchronous handler alone, because uWebSockets.js frees it when that handler returns. Each call into that object costs between 60 and 115 nanoseconds on every request, so read a part of the request only when the route or the code of the app asks for it, and pass a header name as bytes that the module builds once. When the response stays open after the handler returns, copy every part that code can still ask for before the handler returns, as `CopiedRequest.release` does. Attach the body reader before the first asynchronous step, because uWebSockets.js can lose the body bytes that arrive before a reader exists.
- Write a TSDoc comment on every export that reaches a published type file under `dist/`, because `tsc` copies the comment into `dist/*.d.ts`, where an editor shows it on hover. The build fails on an exported declaration without one. Open with what the caller gets, keep the prose plain and British, and describe each parameter and the return value. Link another symbol with `{@link createApp}` and paste no URL. That TSDoc is the only comment in the repository: a non-exported function, a catch block, a test, a config file, a workflow, and a script have none, whatever the reason seems to be.
- Write no `any`, no non-null assertion, and no `@ts-ignore` or `@ts-expect-error` in TypeScript; narrow the type instead.
- Put every test under `packages/ts/src/__tests__/`, in `integration/` when it sends requests through `app.request()`, in `e2e/` when it sends them over a socket to a server from `serve()`, and in `package/` when it checks the built package, because the test runner collects those three directories alone. Inside `integration/`, mirror the source directory that the test covers, and name each `e2e/` file after the behaviour that a client sees. Write an end-to-end test for every behaviour that a client sees on the network, because `app.request()` never calls the code that writes to the socket. In that test, send the whole request that a real client would send, including the body of a request that the server rejects, and check what happened to the connection after the response. `CONTRIBUTING.md` describes the three groups.
- Test each feature only through integration tests on the public uhttp API through `app.request()` and end-to-end tests on a server from `serve()`, written from the side of a hostile user who sends malformed input, reaches and crosses every limit, chooses bad settings, and mixes requests with slow clients, disconnects, and shutdowns. Check every answer against an independent oracle that shares no code with uhttp, because a test that reuses uhttp's own logic can pass while uhttp is wrong.
- Validate data with a Standard Schema validator, which the package accepts from any library that implements the standard, and bind the package to none of them.
- Install a Node package with `pnpm add -E` from inside the target workspace, and a Python package with `uv add` from inside the Python workspace, and leave the dependency blocks of `package.json` and `pyproject.toml` alone otherwise.
- Never propose refusing, narrowing, or deferring a capability because implementing it properly is harder. Read how established servers solve it and what this repository already does, then propose that, and when ease of implementation is your real reason, say so in those words.
- Run the lint, typecheck, build, and test targets of every workspace that you touched before you report a change done.

## Gotchas

- **uWebSockets.js is a required peer dependency.** Its author publishes it on GitHub alone, so a host installs it with `pnpm add -E uWebSockets.js@github:uNetworking/uWebSockets.js#v20.71.0`. The package lists `>=20.70.0 <21` as its peer range, because v20.69.0 and earlier parse a request with duplicate `Content-Length` headers without an error. In `packages/ts/package.json`, the development dependency is the commit of the v20.71.0 tag. The supply-chain gate accepts that one URL dependency when its pin is a version tag or a commit SHA.
- **The ESM entry of uWebSockets.js v20.71.0 is broken.** In that tag, `ESM_wrapper.mjs` imports an `index.js` that is missing from the tag, so `import 'uWebSockets.js'` throws. The package therefore loads uWebSockets.js through `createRequire`, which loads `uws.js` on every version in the peer range.
- **The dependency age gate refuses a package that npm published less than four days ago.** The supply-chain gate refuses an unpinned action reference, a `pull_request_target` trigger, and any URL dependency other than the pinned `uWebSockets.js`.
- **`nx release` writes `packages/ts/CHANGELOG.md`, and a generator writes `BENCHMARKS.md`.** Edit the source that each one reads, and leave the generated file alone.
- **A benchmark result is a committed file.** The generator reads the newest directory under `benchmarks/results/runs/`, so a fresh run of the suite changes what the published page reports. Run the suite only when somebody asks you to.

Read `CONTRIBUTING.md` for the house style and `ROADMAP.md` for where the project is heading.

## Agent skills

### Issue tracker

Issues are GitHub issues on `assetcorp/uhttp`, where every operation goes through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles are the labels, with each label string equal to its role's name. See `docs/agents/triage-labels.md`.

### Domain docs

The repository has a single context, so one `CONTEXT.md` and one `docs/adr/` folder at the root cover all of it. See `docs/agents/domain.md`.
