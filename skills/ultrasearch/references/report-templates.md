# Report templates (per mode)

Each mode has a section skeleton. The **same** skeleton scales across the two
tiers: `SUMMARY.md` = the top-level headings with one or two sentences each;
`REPORT.md` = the full skeleton, filled **exhaustively** — every relevant
source's detail, plus a closing "Open questions / contradictions" section.
The exact skeleton for the active mode is echoed in the run's `DOSSIER.md`.

A template is guidance, not a contract: rename, merge or drop its headings to
fit the material. `check` expects one thing only — an "Open questions" section
(English or French) — and warns when it is missing. `--template <t>` on
`gather` / `ingest` swaps the mode's skeleton for another one: any mode's, or
`verification` below.

## topic
```
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

## bug
```
## TL;DR (likely cause + fastest fix)
## Symptom & reproduction
## Root cause analysis
## Candidate fixes (ranked)
### Fix A — <summary> [confidence]
### Fix B — <summary>
## Related issues & versions affected
## Workarounds
## If still stuck (next diagnostics)
## Sources
```

## research  (also writes refs.bib)
```
## Abstract / TL;DR
## Background & motivation
## Key papers (chronological)
## Methods & approaches compared
## Findings & consensus
## Gaps & open problems
## Future directions
## References (see refs.bib)
## Sources
```

## clinical  (also writes refs.bib)
```
## TL;DR (clinical bottom line)
## Clinical question (PICO)
## Evidence base (trials, systematic reviews, cohorts)
## Efficacy outcomes
## Safety & adverse events
## Guidelines & recommendations
## Certainty of evidence & limitations
## Ongoing & registered trials
## Gaps & open questions
## References (see refs.bib)
## Sources
```

State the design and size of each study you lean on (RCT, n = …; cohort;
case series) next to its `[S#]`: a figure from a 12-patient series and one from
a 600-patient trial are not the same claim. A registered trial
(`clinicaltrials.gov/study/NCT…`) is evidence that a study exists and what it
measures, never of its result unless the record says "Results posted: yes".

## learn  (also writes glossary.md; richest HTML)
```
## Learning objectives
## Prerequisites
## Glossary (see glossary.md)
## Lesson
### Concept 1 — explanation + example
### Concept 2 — explanation + example
## Worked examples
## Exercises
## Solutions
## Further reading
## Sources
```

For `learn`, also write `glossary.md` as `**term** — definition [S#]`, one per
line; `render` links the in-report Glossary heading to it.

## startup
```
## Executive summary
## Problem & customer
## Market sizing (TAM / SAM / SOM)
## Competitive landscape
### Competitor table (name · positioning · pricing)
## Pricing & business models observed
## Go-to-market channels
## Trends & timing
## Risks & moats
## Sources
```

## deals  (also writes codes.json)
```
## TL;DR
## Candidate codes
### Codes table (code · discount · conditions · expires · sources · confidence · tested)
## Merchant's own offers
## Other ways to save
## Sales calendar
## Expired, fake or unverifiable codes
## Sources
```

Start from the **Candidate codes — UNVERIFIED** table in `DOSSIER.md` (full list
in `codes.json`), and keep only the codes you confirmed in the cited extract.
Every data row is a claim: it carries its `[S#]`. `tested` is `no` unless the
code was actually tried in a cart — then `accepted` / `refused` with what the
cart said. Never write a code no source shows, and never complete a partial one.
Expired and single-source codes go under "Expired, fake or unverifiable codes",
cited too.

## verification  (`--template verification`; `refcheck` dossiers carry it)
```
## Verdict
## Reference-by-reference table
### (# · resolved as · authors · title · journal · year · vol · issue · pages · DOI · source)
## Discrepancies
## Claims checked against their sources
## Not verifiable
## Open questions
## Sources
```

For a reference or claim check. Start from `REFCHECK.md` when `refcheck` wrote
the dossier: there source `S<n>` is reference `n`, so a row about reference 12
cites `[S12]`. "Not verifiable" is where an unresolved reference, a record with
no abstract, or a figure only the full text could confirm goes — never silently
dropped.

The `## Sources` section is rendered automatically from `sources.json` into the
HTML appendix — you don't need to hand-list URLs there, but you may add notable
ones. Cite inline with `[S#]` throughout.
