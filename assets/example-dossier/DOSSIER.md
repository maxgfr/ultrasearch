# Search dossier

**Question:** what is rate limiting
**Mode:** topic · **depth:** standard · **lang:** en · **sources:** 3 · **built:** 2026-06-13T10:41:19.578Z
**Backends used:** fixture

> Write two tiers from these sources: `SUMMARY.md` (TL;DR) and `REPORT.md` (the full template below, filled exhaustively — use every relevant source and end with an "Open questions / contradictions" section). Then run `render` and `check`. Do not answer from memory.

## Grounding rules

**Cite every factual claim** with the id of the source it rests on, e.g. `[S1]`
(multiple sources: `[S1][S4]`). The ids are listed below and in `sources.json`.

If you state something from your **own background knowledge** that no fetched
source backs, you must FLAG it as unverified — either end the sentence with
`[M]`, or put the passage in a `> [model-hint] …` blockquote. `ultrasearch check`
tolerates flagged hints but FAILS on any *unmarked* unsourced claim, and on any
`[S#]` that does not resolve to a real source.

## Report template (topic)

```markdown
## TL;DR
## What it is
## How it works / key concepts
## History & evolution
## Current state (today)
## Notable variants / approaches
## Controversies & open debates
## Practical implications
## Sources
```

## Retrieval notes

- fixture backend: offline canned sources (testing only).
- agent: enrich thin areas with your own WebSearch, then ingest each good URL via `ultrasearch fetch --url <u> --out <dir>` before writing the report.

## Sources

### [S1] Rate limiting — overview
url: https://fixture.test/rate-limiting-overview · backend: fixture · trust: 0.5 · extract: `sources/S1.md`

Rate limiting controls how many requests a client may make in a window of time.

### [S2] Rate limiting algorithms
url: https://fixture.test/rate-limiting-algorithms · backend: fixture · trust: 0.5 · extract: `sources/S2.md`

Common algorithms include the token bucket, leaky bucket, fixed window, and sliding window.

### [S3] HTTP 429 and Retry-After
url: https://fixture.test/rate-limiting-http-429 · backend: fixture · trust: 0.5 · extract: `sources/S3.md`

A rate-limited request returns HTTP 429 Too Many Requests, often with a Retry-After header.
