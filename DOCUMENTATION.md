# ultrasearch — architecture

ultrasearch is the web-facing sibling of [ultradoc](https://github.com/maxgfr/ultradoc):
the same shape (one committed, zero-dependency Node bundle; deterministic
retrieval that writes an evidence dossier; a `check` command that fails on
ungrounded claims), pointed at the open web instead of a git repo.

## Pipeline

```
question
  │  gather
  ▼
plan query variants (full question + keywords + identifiers, by depth)
  │
[ backends ] ── fan out concurrent, keyless, per-variant ──► RawSource[] per backend
  │  fuse (RRF over DOI/arXiv-id identity, else canonical URL) + exclude-domains
  │  hydrate a candidate pool (bounded concurrency, retry on 429/503)
  │  re-rank by content keyword-coverage + fusion rank + trust, THEN cap
  ▼
dossier on disk:  manifest.json · sources.json · sources/S#.md · DOSSIER.md
  │  (research mode also writes refs.bib)
  ▼
the AGENT reads DOSSIER.md, enriches via its own WebSearch (`fetch --url`),
then writes SUMMARY.md / REPORT.md / FULL.md  (+ glossary.md for learn)
  │  render                                   │  check
  ▼                                           ▼
index.html (self-contained)        grounding verdict (exit≠0 if ungrounded)
```

The split mirrors ultradoc: the CLI does deterministic retrieval and leaves the
writing to the model; `check` is the mechanical guard against answering from
memory.

### Deep research tier (the agentic loop)

On top of the single pass, an opt-in tier adds a deep-research harness, driven by
SKILL.md and bounded by `DEEP_CAPS`:

```
plan (decompose into sub-questions)
  │  one `gather --depth deep` per sub-question (parallel subagents or sequential)
  ▼
merge (re-fuse the combined pool by identity + near-dup, stable S# ids, provenance)
  ▼
the AGENT writes the tiers against the MASTER dossier
  │  verify (extract claim↔source pairs)  →  agents adjudicate support/refute
  ▼
verify --apply + check --semantic  (fail on refuted/unsupported claims)
  │  loop until a round surfaces no new sub-questions / gaps
  ▼
render (verdict badges + sub-question tree)
```

Retrieval stays deterministic and keyless; the agent supplies decomposition,
enrichment, report writing, and verdicts. See `references/deep-research-playbook.md`.

## Modules (`src/`)

- `cli.ts` — arg parser (`COMMANDS` / `VALUE_FLAGS` / `BOOL_FLAGS`), `HELP`, and
  `main()` dispatch for gather / search / fetch / render / check / modes / plan /
  merge / verify.
- `types.ts` — `VERSION` + every interface (`Source`, `RawSource`, `Manifest`,
  `ModeProfile`, `CheckResult`, `SubQuestion`, `Verdict`, `VerifyResult`, …) and
  the `DEPTH_CAPS` + `DEEP_CAPS` tables.
- `util.ts` — slug/runId, URL canonicalization + dedupe, trust scoring, and the
  keyword/matcher/RRF machinery (ported from ultradoc) used to excerpt pages.
- `gather.ts` — the orchestrator: resolve backends → run → fuse → dedupe → cap →
  hydrate → write dossier (+ refs.bib for research).
- `dossier.ts` — `writeDossier` / `readDossier` / `buildSource` / `nextSourceId`
  and the DOSSIER.md renderer; the `CITATION_RULES` block.
- `enrich.ts` — `addSource`: the WebSearch→dossier bridge behind `fetch`.
- `check.ts` — the citation grammar + grounding algorithm (with model-hint
  tolerance and per-claim coverage on REPORT/FULL); exports the claim parser
  (`unitsOfFile` / `unitSourceTokens`) for `verify`, and the `--semantic` fold.
- `plan.ts` — deterministic sub-question decomposition (`runPlan`) for the deep tier.
- `merge.ts` — `runMerge`: union sub-dossiers into one master with stable `S#`
  ids, re-fusing + de-duplicating the combined pool and recording provenance.
- `verify.ts` — `runVerify` (claim↔source worklist) + `applyVerdicts` /
  `reduceVerdicts` (the semantic gate).
- `render.ts` — the zero-dependency markdown→HTML renderer + page assembly
  (verdict badges + sub-question tree in deep mode).
- `bibtex.ts` — `toBibtex` for research mode's `refs.bib`.
- `modes/` — the five `ModeProfile`s + their registry.
- `backends/` — `fetch.ts` (HTTP + HTML→text + excerpting), the `registry.ts`
  runner, and one file per backend.

## Build & release

- `tsup` bundles `src/cli.ts` → the committed `scripts/ultrasearch.mjs` (ESM,
  node18, no minify). `pnpm run check:build` proves it's reproducible.
- semantic-release (Conventional Commits) computes the next version,
  `scripts/sync-version.mjs` syncs it across `package.json` / `src/types.ts` /
  `SKILL.md`, the bundle is rebuilt, and a GitHub release + tarball are cut.
- CI runs typecheck, the reproducible-build check, vitest (fully offline), an
  offline smoke run, the offline evals, and a Node-18 floor job that runs the
  committed bundle with no devDeps.

## Grounding model

`sources.json` is the source of truth `check` validates against. The agent cites
`[S#]`; any `[S#]` that doesn't resolve, or any unmarked unsourced prose claim in
REPORT/FULL, fails the run. Background knowledge is allowed only when flagged
(`[M]` or `> [model-hint]`), which `check` tolerates and the HTML renders as a
distinct "unverified" callout.
