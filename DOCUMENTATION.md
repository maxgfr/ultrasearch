# ultrasearch — architecture

ultrasearch is the web-facing sibling of [ultradoc](https://github.com/maxgfr/ultradoc):
the same shape (one committed, zero-dependency Node bundle; deterministic
retrieval that writes an evidence dossier; a `check` command that fails on
ungrounded claims), pointed at the open web instead of a git repo.

## Pipeline

```
question
  │  queries → the agent runs its OWN WebSearch, N distinct angles, pools the hits
  ▼
[ --web-results ] ── the WebSearch lane (backend "claude"), the primary engine
  │  gather
  ▼
plan query variants (full question + keywords + identifiers, by depth)
  │
[ backends ] ── fan out concurrent, keyless, per-variant ──► RawSource[] per backend
  │  (--search light: the lane + the mode's API backends only.
  │   --search full: also the scraped cascade + SearXNG, all fused.
  │   auto = light when a lane was supplied, full when it was not)
  │  (web discovery walks engines in concurrent waves up to --web-breadth;
  │   polite scholarly APIs serialize their per-variant calls)
  │  fuse (RRF over DOI/arXiv-id identity, else canonical URL) + exclude-domains
  │  hydrate a candidate pool (bounded concurrency, retry on 429/503, on-disk
  │   cache; HTML via a self-hosted Firecrawl when one answers, else the
  │   built-in reader; junk/consent-wall extractions re-tried through Firecrawl
  │   then rejected; dead links → Wayback)
  │  re-rank by content keyword-coverage + fusion rank + trust, then re-order
  │   for DIVERSITY (MMR: the fourth restatement of an argument already covered
  │   loses its slot to the first source covering new ground). No cap: every
  │   page fetched, on-topic and de-duplicated is kept.
  │  map per-term coverage → the under-covered enrichment worklist
  ▼
dossier on disk:  manifest.json · sources.json · sources/S#.md · DOSSIER.md
  │  (research mode also writes refs.bib)
  ▼
the AGENT reads DOSSIER.md, tops up the gaps with a second WebSearch round
(`ingest --web-results`, one process for the whole round), then writes
SUMMARY.md / REPORT.md  (+ glossary.md for learn)
  │  render                                   │  check
  ▼                                           ▼
index.html (self-contained)        grounding verdict (exit≠0 if ungrounded)
```

The split mirrors ultradoc: the CLI does deterministic retrieval and leaves the
writing to the model; `check` is the mechanical guard against answering from
memory.

### Deep research tier (the agentic loop)

On top of the single pass, an opt-in tier adds a deep-research harness, driven by
SKILL.md. `DEEP_CAPS` bounds two of its dimensions in code — `maxSubQuestions`
(enforced by `plan`) and `maxVerify` (enforced by `verify`) — while `maxRounds`
and `perSubQuestionSources` are **advisory**: the loop-until-dry cycle is
agent-driven, and the latter is redundant with `DEPTH_CAPS.deep.maxSources`.

```
plan --run-root (decompose into sub-questions, each with a deterministic out dir)
  │  one `gather --depth deep` per sub-question (parallel subagents or sequential)
  ▼
merge (re-fuse the combined pool by identity + near-dup, stable S# ids, provenance)
  ▼
the AGENT writes the tiers against the MASTER dossier
  │  verify [--shards N --shard I] (claim↔source worklist) → skeptics adjudicate
  ▼
verify --apply <files|dir> + check --semantic --require-verify  (fail on
  │  refuted/unsupported, or a missing/empty VERIFY.json; surfaces contradictions)
  │  loop until a round surfaces no new sub-questions / gaps
  ▼
render (verdict badges + contradictions panel + sub-question tree)
```

Retrieval stays deterministic and keyless; the agent supplies decomposition,
enrichment, report writing, and verdicts. `plan --run-root` hands the orchestrator
the sub-run dirs up front (no stdout parsing) and `verify --shards` partitions the
worklist for parallel skeptics. Three quality signals are surfaced for the agent
to act on: a **recall floor** (thin-dossier warning + `check --min-sources`),
**source quality** (`fullText:false` snippet-only marker when a page fetch fails),
and **contradictions**. A fourth, **under-covered terms**, names the question
terms the kept sources barely mention — computed in-memory from the hydrated
extracts, so it costs no extra retrieval. See
`skills/ultrasearch/references/deep-research-playbook.md`.

## Modules (`src/`)

- `cli.ts` — arg parser (`COMMANDS` / `VALUE_FLAGS` / `BOOL_FLAGS`), `HELP`, and
  `main()` dispatch for gather / search / fetch / add-source / render / check /
  modes / brainstorm / plan / merge / verify / orchestrate.
- `types.ts` — `VERSION` + every interface (`Source`, `RawSource`, `Manifest`,
  `ModeProfile`, `CheckResult`, `SubQuestion`, `Verdict`, `VerifyResult`, …) and
  the `DEPTH_CAPS` + `DEEP_CAPS` tables.
- `util.ts` — slug/runId, URL canonicalization + dedupe, trust scoring, and the
  keyword/matcher/RRF machinery (ported from ultradoc) used to excerpt pages.
- `gather.ts` — the orchestrator: resolve backends → run (web discovery in
  concurrent cascade waves) → fuse → dedupe → cap → hydrate (junk-extraction
  rejection, arXiv/Wayback fallbacks) → write dossier (+ refs.bib for research).
- `cache.ts` — the on-disk fetch cache (on by default, `--no-cache` disables it):
  keyed by canonical URL **+ Accept-Language + extractor identity** so neither a
  locale nor an extractor is ever served the other's body, TTL-bounded,
  successes only, shared across the deep tier's fan-out gathers.
- `dossier.ts` — `writeDossier` / `writeDossierIndex` / `writeSourceExtract` /
  `writeBibtex` / `readDossier` / `buildSource` / `nextSourceId` / `readJson`
  (guarded parse) and the DOSSIER.md renderer; the `CITATION_RULES` blocks (one
  for a normal run, one for a run that wrote nothing and therefore has no
  `check` gate to invoke).
- `no-write.ts` — the `--stdout` / `ULTRASEARCH_NO_WRITE` gate. Every `mkdirSync`
  and `writeFileSync` in `src/` goes through its `ensureDir` / `writeArtifact`,
  which collect artifacts in memory instead of writing when the gate is on, so
  "nothing was written" is a property of one module rather than a promise each
  command keeps. `cli.ts` streams the collected artifacts to stdout.
- `enrich.ts` — `addSource` (behind `fetch`) and `addSources` (behind `ingest`,
  the batch form). Deliberately sequential: `addSource` reads sources.json, picks
  the next free `[S#]` and writes it back, so two concurrent calls would both
  claim the same id and leave a citation resolving to the wrong page. Stable ids
  are what the grounding contract rests on; the saving `ingest` delivers is the
  N process spawns and N agent round-trips, which is where the cost actually was.
- `backends/websearch.ts` — the harness WebSearch lane (backend kind `claude`).
  `parseWebResults` is the forgiving seam between a model's output and the
  engine — object arrays, bare URL arrays, `{results:[…]}` wrappers, newline
  lists — and it COUNTS what it refuses rather than silently halving recall. The
  backend itself carries no text, so every hit is hydrated and wall-checked like
  any other candidate.
- `queries.ts` — `planQueries`: the agent's WebSearch worklist (how many distinct
  queries for the depth, plus the mode's `searchAngles`). The engine cannot run
  the agent's search tool, so the next best thing is saying precisely what to
  search — one query against a great index is still only one slice of it.
- `check.ts` — the citation grammar + grounding algorithm (with model-hint
  tolerance and per-claim coverage on REPORT); exports the claim parser
  (`unitsOfFile` / `unitSourceTokens`) for `verify`, and the `--semantic` fold.
- `claims.ts` — the shared claim parser (`check`, `verify` and `render` all import
  it, so they can never disagree on what a claim is). Masks code fences, HTML
  comments, model-hint blockquotes and the trailing Sources appendix.
- `locale.ts` — pure locale derivation (`Accept-Language`, DuckDuckGo `kl`).
- `brainstorm.ts` — `runBrainstorm`: the clarity gate's shallow probe, ambiguity
  signals and candidate angles.
- `plan.ts` — deterministic sub-question decomposition (`runPlan`) for the deep tier.
- `orchestrate.ts` + `orchestrate-templates.ts` — `orchestrateRun`: emits the
  per-phase Workflow scripts, the `agents/<role>.md` dispatch contracts and the
  sequential `RUNBOOK.md` from the run's current worklists.
- `merge.ts` — `runMerge`: union sub-dossiers into one master with stable `S#`
  ids, re-fusing + de-duplicating the combined pool and recording provenance.
- `verify.ts` — `runVerify` (claim↔source worklist) + `applyVerdicts` /
  `reduceVerdicts` (the semantic gate).
- `render.ts` — the zero-dependency markdown→HTML renderer + page assembly
  (verdict badges + sub-question tree in deep mode).
- `bibtex.ts` — `toBibtex` for research mode's `refs.bib`.
- `services.ts` — the optional helpers as one surface: `probeServices` (what is
  reachable right now, behind `doctor`), `describeServices` (the one-line
  `Helpers:` run summary) and `compose` (`searxng|firecrawl up|down`). Exists
  because every helper is skipped in SILENCE when absent, which is right per URL
  and wrong once per run: a container could sit up for weeks, never be queried,
  and nothing anywhere would say so.
- `backends/pdf.ts` + `backends/pdf/` — the PDF extractor ladder.
  `ladder.ts` tries pdf-inspector (`npx`, PDF on stdin, child process so a crash
  can't take the run down) → anydoc (the same conversion, but the only npm rung
  with a `darwin-x64` binary) → Firecrawl → `pdftotext` → `native.ts` → `ocr.ts`, stopping
  at the first rung whose output passes `quality.ts`. That gate rejects C0/C1 and
  U+FFFD-laced text at ANY length — the built-in reader can emit 16 MB of
  image-stream garbage for a 12 MB paper, which every length-limited check waves
  through. `ocr.ts` is the last rung and the only one that reads a page with NO
  text layer, via copyable-pdf + tesseract: it owns a temp file (the tool takes a
  path, not stdin), checks both binaries itself so copyable-pdf's interactive
  `brew install` prompt is never reached, and is budgeted per process because it
  costs ~2.7s per page. Nothing readable ⇒ the source is refused with a reason,
  not cited — and a scan skipped for budget says that instead.
- `backends/doc.ts` + `backends/doc/` — the same shape for office documents.
  `formats.ts` is the only place a format is decided, which is what keeps a
  URL-derived string out of a converter's argv; `ladder.ts` tries anydoc
  (`npx`, bytes on stdin) → Firecrawl and reuses the PDF ladder's `exec.ts` and
  quality gate. It has no built-in last rung on purpose: unzipping OOXML and
  walking its parts is a different order of problem from mining a text layer,
  and a wrong answer is worse than none. The refusal is the feature — a `.docx`
  is a ZIP, so the fall-through this replaced put kilobytes of U+FFFD into
  dossiers as citable evidence, silently.
- `modes/` — the five `ModeProfile`s + their registry.
- `backends/` — `fetch.ts` (HTTP + the extraction seam + HTML→text + excerpting
  + junk detection + Wayback rescue), the `registry.ts` runner (with the
  polite-sequential fan-out), and one file per backend (web discovery, scholarly
  incl. `dblp`, community).
- `backends/firecrawl.ts` — the self-hosted Firecrawl client: base resolution
  (`--firecrawl` > `ULTRASEARCH_FIRECRAWL` > `http://localhost:3002`, `off`
  disables), a memoised 2s availability probe, the `/v2`→`/v1` prefix fallback,
  `/scrape` + `/search`, and the pure `mapScrapeResponse` / `mapSearchResponse`
  mappers. Every failure degrades to a note and the built-in extractor.

## Optional self-hosted stack

`docker-compose.yml` carries two **profiles**; a bare `docker compose up -d`
starts nothing:

- `search` → SearXNG on `:8888` (JSON output enabled in
  `docker/searxng/settings.yml`, `limiter: false` because the bot-detection
  middleware answers 403 to `format=json`), backing the `searxng` backend.
- `extract` → the Firecrawl stack on `:3002` (api + playwright + redis +
  rabbitmq + nuq-postgres), keyless via `USE_DB_AUTHENTICATION=false`. Kept out
  of `all` because it is ~3 GB of images. Firecrawl's own `/search` is pointed at
  the SearXNG container, so that path stays keyless too.

The engine treats Firecrawl as strictly optional: one memoised probe decides
availability per process, and every failure path falls back to the built-in
extractor with a note.

## Build & release

- `tsup` bundles `src/cli.ts` → the committed `scripts/ultrasearch.mjs` (ESM,
  node18, no minify). `pnpm run check:build` proves it's reproducible.
- semantic-release (Conventional Commits) computes the next version,
  `scripts/sync-version.mjs` syncs it across `package.json` / `src/types.ts` /
  `SKILL.md`, the bundle is rebuilt, and a GitHub release + tarball are cut.
- CI runs typecheck, lint, the reproducible-build check, vitest (fully offline)
  with a coverage ratchet, an offline smoke run, the offline evals (incl. a
  RED/GREEN semantic-gate probe), and a Node-18 floor job that runs the committed
  bundle with no devDeps. Saved-response canaries (`tests/fixtures/api/`) catch
  scholarly-API schema drift; a weekly network eval reports live-backend recall.

## Grounding model

`sources.json` is the source of truth `check` validates against. The agent cites
`[S#]`; any `[S#]` that doesn't resolve, or any unmarked unsourced prose claim in
REPORT, fails the run. Background knowledge is allowed only when flagged
(`[M]` or `> [model-hint]`), which `check` tolerates and the HTML renders as a
distinct "unverified" callout.
