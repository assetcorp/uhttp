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
- `pnpm lint` checks the code with Biome.
- `pnpm typecheck` type-checks the TypeScript.
- `pnpm format` applies Biome formatting.
- `pnpm nx run uhttp:api:write` rewrites the API reports in `packages/ts/etc/`. Run it after you change an export, because the build fails until the committed reports match the exports.
- `pnpm nx run uhttp:speed` measures one route on bare uWebSockets.js and on uhttp for 10 seconds each at 100 connections, and it fails when uhttp is more than 10% slower. Close other busy programs first, because on a busy machine the result can vary by more than 10% in either direction.

On every pull request, the `Speed` workflow compares the speed of the change with main and writes a table to its summary. The `Speed comment` workflow then posts that table as a comment on the pull request, and it updates the same comment after each push. The workflow passes whatever the table contains.

## Repository layout

- `packages/ts` holds the package that the publish workflow releases to npm as `@delali/uhttp`.
- `benchmarks` holds the benchmark suite and the generator that writes `BENCHMARKS.md`.
- `docs` holds the guides that the README links to.

## Conventions

- Keep each source file under 400 lines. When you split a module across several files, put them in a directory with an `index.ts` that re-exports the module.
- Let Biome format the code, and keep the layout that it writes.
- Write a TSDoc comment on every published export, and write no other comment anywhere.
- Put every test under `packages/ts/src/__tests__/`, mirroring the directory that it covers.

## Propose a change

- For a small first change, look for issues that carry the `good first issue` label.
- For a bug, open an issue with the bug template so that the report includes the version, the Node.js version, and a reproduction.
- For a larger change, open an issue to discuss the design before you write the code.

## Licence

By contributing, you agree that your contribution falls under the MIT licence that covers the project.
