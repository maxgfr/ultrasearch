# ultrasearch — comprehensive quality pass (design)

Date: 2026-07-07 · Status: approved

## Goal

Exercise the `ultrasearch` skill for real against the live web across all five
modes + the deep tier, fill the offline coverage gaps (especially weak
branches), fix every real bug that surfaces, and ship to `main` via conventional
commits (semantic-release).

## Baseline (before this pass)

- 39 test files, 366 tests, all green, fully offline (`fetch` mocked).
- Coverage: statements 94.3% · branches 83.5% · functions 96.5% · lines 96.5%,
  ratcheted in `vitest.config.ts`.
- Weak branch coverage: `wikipedia` 61%, `stackexchange` 66%, `generic`/`merge`
  69%, `bibtex`/`dossier` 74%; `cli` statements 87%.
- Strict CI gates: `check:build` (bundle byte-identity), coverage ratchet, drift
  canaries, offline evals, semantic-release on push to `main`.

## Two test dimensions

### A — Real-life E2E against the live network (new)

Run the *actual documented SKILL.md workflow* with real queries and inspect
every output for crashes / empty results / malformed dossiers. This is where
real parser-drift bugs surface — the entire offline suite mocks `fetch`.

| Mode | Real query |
|------|-----------|
| topic | "what is rate limiting" |
| bug | a real React `TypeError` |
| research | "retrieval augmented generation" (+ `refs.bib`) |
| learn | "how TCP congestion control works" (+ `glossary.md`) |
| startup | "AI meeting-notetaker market" |
| deep | one question: `plan → gather --cache → merge → verify → check --semantic` |
| locale | a `--lang fr` search |

Also exercise `render` (HTML + md) and `check` on a real dossier.

### B — Offline coverage gap-filling

For each weak module, read the uncovered branches, write a test exercising them;
raise the ratchet afterward. Uncovered hot-spots to target:
`bibtex` 14-20,40-41,48 · `merge` 50,65-80,89-118 · `dossier` 29 ·
`generic` 11 · `wikipedia` 8,23-40 · `stackexchange` 22,25-54 ·
`cli` 463-478,568.

## Methodology (per bug, either dimension)

RED probe (a failing test, often a captured real response turned into a fixture)
→ fix in `src/` only → GREEN → `pnpm run build` (regenerate bundle) → commit.
Every live bug becomes a fixture-based offline regression test so the mocked
suite guards it forever.

## Gates before every push to `main`

`pnpm test` · `pnpm run typecheck` · `pnpm run lint` · `pnpm run build` +
`pnpm run check:build` · `pnpm run eval` · coverage ratchet raised-only.

## Delivery

Direct to `main`, Conventional Commits, one logical change per commit:
`test:` (test-only) · `fix:` (bug → patch release) · `chore(coverage):` (ratchet
bumps) · `chore(deps):` (vitest/coverage-v8 version-mismatch warning). Rebuild +
commit the bundle whenever `src/` changes. semantic-release versions/tags.

## Scope guardrails (YAGNI)

No new backends, no new modes, no unrelated refactors. Node-18 floor respected,
zero runtime dependencies preserved.
