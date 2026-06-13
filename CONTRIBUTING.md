# Contributing to ultrasearch

Thanks for helping! ultrasearch ships as **one committed, dependency-free
bundle** (`scripts/ultrasearch.mjs`) built from the TypeScript in `src/`. Agents
run the bundle directly with `node` — no install at skill-use time.

## Dev setup

```bash
pnpm install            # devDeps only (tsup, vitest, typescript, semantic-release)
pnpm run build          # src/ → scripts/ultrasearch.mjs (tsup)
pnpm test               # vitest, fully offline (network is mocked)
pnpm run typecheck      # tsc --noEmit
pnpm run check:build    # tsup && git diff --exit-code -- scripts/ultrasearch.mjs
```

## The golden rules

1. **Edit `src/`, never `scripts/ultrasearch.mjs` by hand.** The bundle is
   generated. Run `pnpm run build` and commit the regenerated bundle alongside
   your source change. CI fails (`check:build`) if the committed bundle is stale.
2. **No runtime dependencies.** Anything you need (e.g. a markdown renderer)
   must be hand-rolled or tsup-inlined into the bundle. `package.json` has
   `devDependencies` only.
3. **Tests stay offline.** Backends must go through the single HTTP layer in
   `src/backends/fetch.ts`; tests stub `globalThis.fetch` with fixtures. Never
   hit the live network in `vitest run`.
4. **The Node-18 floor is real.** The bundle declares `engines.node >=18`. Don't
   use a Node 20+ runtime API in `src/` — CI runs the committed bundle on Node 18.

## Commits & releases

We use [Conventional Commits](https://www.conventionalcommits.org/). On every
push to `main`, semantic-release computes the next version (`feat` → minor,
`fix` → patch, `!`/`BREAKING CHANGE` → major), syncs it across `package.json`,
`src/types.ts` and `SKILL.md` via `scripts/sync-version.mjs`, rebuilds the
bundle, tags `v<version>`, and creates the GitHub release.

## Adding a backend

1. Add a file in `src/backends/` exporting a `Backend` handler.
2. Register it in `src/backends/registry.ts`.
3. Add it to the relevant mode profiles in `src/modes/`.
4. Add a fixture in `tests/fixtures/` and a parse test.
5. Document its endpoint + rate limits in `references/backend-apis.md`.

## Adding a mode

1. Add `src/modes/<mode>.ts` with a `ModeProfile` (backend priority + template).
2. Register it in `src/modes/registry.ts`.
3. Document the template in `references/report-templates.md`.
