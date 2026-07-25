# Contributing to ultrasearch

Thanks for helping! ultrasearch ships as **one committed, dependency-free
bundle** (`scripts/ultrasearch.mjs`) built from the TypeScript in `src/`. Agents
run the bundle directly with `node` — no install at skill-use time.

## Dev setup

```bash
pnpm install            # devDeps only (tsup, vitest, typescript, semantic-release)
pnpm run build          # src/ → scripts/ultrasearch.mjs (tsup) → mirrored into skills/
pnpm run typecheck      # tsc --noEmit
pnpm run lint           # biome ci .
pnpm test               # vitest, fully offline (network is mocked)
pnpm run test:coverage  # same, with the coverage ratchet (see vitest.config.ts)
pnpm run check:build    # the composite gate: rebuild + mirror + both bundles
                        # committed byte-identical + verify:bundle
pnpm run eval           # offline eval suite (gates CI)
```

`check:build` is the one to run before pushing: it rebuilds, re-mirrors, fails if
either committed bundle differs, and then runs `verify:bundle` (install shape +
the doc↔CLI drift gate).

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

## The skill bundle's own invariants

The skill ships from `skills/ultrasearch/`, and `scripts/verify-skill-bundle.mjs`
enforces four things that are easy to trip:

1. **No `SKILL.md` at the repo root** — `skills add` would install it alone,
   dropping the engine and the references.
2. **`references/` is bidirectional** — every `references/*.md` on disk must be
   mentioned in `SKILL.md`, and every mentioned file must exist. Adding a
   reference without linking it fails CI.
3. **Docs ⊆ CLI** — every `--flag` appearing in `SKILL.md` or any
   `references/*.md` must be a real flag, and every CLI flag must appear in
   `HELP`. (`SKILL.md` promises `--help` is the full surface.)
4. **One `--web-engine` value list** — the canonical enumeration lives in
   `references/web-discovery.md` and must match `ALL_WEB_ENGINES` exactly. At
   least one such list must exist, so reformatting it away also fails.

`skills/ultrasearch/SKILL.md` is additionally pinned by `tests/skill-md.test.ts`:
the version tracks `src/types.ts`, the description must stay ≤1000 chars, and a
handful of section headings and sentences are matched literally.

## Adding a backend

1. Add a file in `src/backends/` exporting a `Backend` handler.
2. Register it in `src/backends/registry.ts`.
3. Add it to the relevant mode profiles in `src/modes/`.
4. Add a fixture in `tests/fixtures/` and a parse test.
5. Document its endpoint + rate limits in
   `skills/ultrasearch/references/backend-apis.md`.
6. If it is a web-discovery engine, update the canonical `--web-engine`
   enumeration in `skills/ultrasearch/references/web-discovery.md` — invariant 4
   above fails otherwise.

## Adding a mode

1. Add `src/modes/<mode>.ts` with a `ModeProfile` (backend priority + template).
2. Register it in `src/modes/registry.ts`.
3. Document the template in
   `skills/ultrasearch/references/report-templates.md` and the profile in
   `skills/ultrasearch/references/modes.md`.
