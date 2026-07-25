# evals

Two suites exercise the committed bundle (`scripts/ultrasearch.mjs`):

```bash
pnpm run eval           # offline — deterministic, gates CI
pnpm run eval:network   # network — hits real keyless backends, report-only
```

## offline (`--suite offline`)

Runs the cases in `cases/offline/*.json` against the built-in **fixture**
backend (no network), asserting each writes a dossier with the expected sources
(and, for research, `refs.bib`). Any failure exits non-zero — this is a
regression gate in CI.

Each offline case: `{ id, question, mode, backends, minSources, mustInclude?, expectFile? }`.

Four probes then exercise behaviour the cases can't, end-to-end through the
committed bundle:

| Probe | Asserts |
|---|---|
| `[example]` | the committed `assets/example-dossier` still passes `check` (stays grounded) |
| `[semantic-gate]` | RED: a `refuted` verdict fails `verify --apply` **and** `check --semantic`. GREEN: a `supported` one passes both. And `--require-verify` fails when nothing was adjudicated. |
| `[numeral-gate]` | a claim asserting a figure its source never states WARNS by default (exit 0) and FAILS under `--strict-numerals` |
| `[signals]` | `gather` names the under-covered question terms (manifest + `DOSSIER.md` + report) and says out loud when `--backends` voided `--seed-domains`/`--rounds` |

## network (`--suite network`)

Runs `cases/network/*.json` against real backends (Wikipedia, arXiv, Hacker
News, …) and prints how many sources each returned. It **never fails** — the live
web drifts and rate-limits — so it's run on a schedule / manual dispatch, not on
every PR.
