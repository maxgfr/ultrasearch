# Report templates (per mode)

Each mode has a section skeleton. The **same** skeleton scales across the three
tiers: `SUMMARY.md` = the top-level headings with one or two sentences each;
`REPORT.md` = the full skeleton, filled; `FULL.md` = the skeleton plus every
relevant source's detail and a closing "Open questions / contradictions".
The exact skeleton for the active mode is echoed in the run's `DOSSIER.md`.

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

The `## Sources` section is rendered automatically from `sources.json` into the
HTML appendix — you don't need to hand-list URLs there, but you may add notable
ones. Cite inline with `[S#]` throughout.
