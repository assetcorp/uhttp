# Contributing to uhttp

This guide covers how to set up the repository, check a change, and propose it.

## Prerequisites

- You need Node.js 22 or newer.
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
