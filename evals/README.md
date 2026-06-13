# evals

Two suites exercise the committed bundle (`scripts/ultrasearch.mjs`):

```bash
pnpm run eval           # offline — deterministic, gates CI
pnpm run eval:network   # network — hits real keyless backends, report-only
```

## offline (`--suite offline`)

Runs the cases in `cases/offline/*.json` against the built-in **fixture**
backend (no network), asserting each writes a dossier with the expected sources
(and, for research, `refs.bib`). Then two structural checks: the committed
`assets/example-dossier` must still pass `ultrasearch check` (stays grounded).
Any failure exits non-zero — this is a regression gate in CI.

Each offline case: `{ id, question, mode, backends, minSources, mustInclude?, expectFile? }`.

## network (`--suite network`)

Runs `cases/network/*.json` against real backends (Wikipedia, arXiv, Hacker
News, …) and prints how many sources each returned. It **never fails** — the live
web drifts and rate-limits — so it's run on a schedule / manual dispatch, not on
every PR.
