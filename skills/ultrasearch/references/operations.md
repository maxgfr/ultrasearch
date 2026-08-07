# Operations — exit codes, cost, caching, tuning, troubleshooting

Everything about *running* ultrasearch well: what an exit code means, what a run
costs, which knobs are safe to turn, and how to get unstuck. SKILL.md is the
decision surface; this is the operations manual.

## Exit codes

| Command | Exit | Meaning |
|---|---|---|
| `gather` | 1 | **Empty dossier** — every backend returned nothing usable. The output prints a 3-step bridge protocol. Never write tiers over this. |
| `check` | 1 | Ungrounded: a dangling `[S#]`, an unmarked unsourced claim, no citations at all, or a `--semantic`/`--min-sources`/`--strict-numerals` failure. |
| `verify --apply` | 1 | The semantic gate failed — a claim its source refutes, or one whose every cited source is unsupported. |
| `orchestrate` | 2 | The run dir does not exist, or `--phase <p>` was asked for before its worklist existed. The error names the command that produces it. |
| `merge` · `fetch` · `relink` · `verify` · `orchestrate` | 2 | Run under `--stdout` / `ULTRASEARCH_NO_WRITE=1`. Each exists to leave files behind for a later process, so it refuses rather than return something nobody can act on. |
| `render` | 2 | `--stdout --no-md` — that combination leaves nothing to emit, because `--stdout` never produces HTML. |

Anything non-zero means *stop and fix*, never *present anyway*.

## What a run costs

| Route | Engine processes | Sources kept | Wall clock |
|---|---|---|---|
| lookup (`--depth summary`) | 1 | ≤10 | ~30s |
| report (`--depth standard`) | 1, or 1 + one gatherer per sub-question | ≤25 | ~2-4 min |
| deep (`--depth deep`) | 1 plan + N gathers + 1 merge + skeptic batches | ≤60 per sub-run | ~10-20 min |

Per-depth retrieval budget (`src/types.ts`, override with the flags in brackets):

| Depth | max sources `[--max-sources]` | per backend `[--per-source]` | result pages `[--pages]` | engines fused `[--web-breadth]` | recall floor |
|---|---|---|---|---|---|
| `summary` | 10 | 4 | 1 | 1 | 3 |
| `standard` | 25 | 6 | 2 | 2 | 6 |
| `deep` | 60 | 10 | 3 | 5 | 12 |

The **recall floor** is the "thin dossier" threshold: below it, `gather` flags the
run, `DOSSIER.md` gets a banner, and `check` warns. `check --min-sources <n>`
turns that into a hard failure for a high-stakes run.

## The fetch cache

**On by default.** Pass `--no-cache` for an all-live run.

- On disk, shared **across processes** — the deep tier's fan-out fetches an
  overlapping URL once instead of once per sub-question.
- Keyed by canonical URL, the `Accept-Language` the fetch will send **and the
  extractor** that cleaned it — so a `--lang de` run is never served a body
  cached by a `--lang en` run, and bringing Firecrawl up is not masked for a
  whole TTL by yesterday's natively-extracted entries.
- **Only successful extractions are stored.** A failed or empty fetch always
  retries. A corrupt entry is ignored and overwritten, never thrown.
- 24h TTL. Discovery is **never** cached — only page bodies. Every search query
  goes out live on every run, so `--since` and "what's the latest" keep working;
  only the body of an already-discovered page can be up to a day old.
- `manifest.cache` records `{ enabled, hits }`, and a note names the hit count,
  so a dossier is self-describing about how fresh its pages are.
- Under `--stdout` the cache degrades to **read-only**: a run is still served
  by whatever an earlier normal run left there, but leaves nothing of its own.

## Concurrency and politeness

These services are free, keyless and unauthenticated. Staying welcome matters
more than saving ten seconds.

- `--concurrency <n>` (default 6) bounds in-flight page fetches.
- Rate-limited backends (GitHub, Stack Exchange, Semantic Scholar, PubMed) get a
  single query variant per run; the polite scholarly APIs (arXiv, Crossref,
  OpenAlex, Europe PMC, dblp) run their per-variant calls sequentially.
- Every request retries once on 429/503/502/504, honouring `Retry-After`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ULTRASEARCH_SEARXNG` | `http://localhost:8888` | SearXNG base URL (same as `--searxng`). Opt-in: unset ⇒ the backend skips without calling out. |
| `ULTRASEARCH_FIRECRAWL` | `http://localhost:3002` | Self-hosted Firecrawl base URL (same as `--firecrawl`). `off` disables it. Unreachable ⇒ silently skipped after one 2s probe. |
| `ULTRASEARCH_FIRECRAWL_KEY` | unset | Optional `Authorization: Bearer` for the Firecrawl API. Not needed self-hosted — only to point the same client at Firecrawl Cloud. |
| `ULTRASEARCH_PDF_ENGINE` | unset | Force ONE rung of the PDF extractor ladder: `pdf-inspector`, `anydoc`, `firecrawl`, `pdftotext` or `native`. Unset ⇒ the full ladder, strongest first. |
| `ULTRASEARCH_DOC_ENGINE` | unset | Force ONE rung of the office-document ladder (`anydoc`, `firecrawl`), or `none` to disable it — office documents are then refused rather than read. |
| `ULTRASEARCH_NO_NPX` | unset | Set to skip both rungs that need an implicit `npx` install (`pdf-inspector`, `anydoc`). Useful offline, or where an unattended install is not acceptable. |
| `ULTRASEARCH_NO_WRITE` | unset | `1` makes every command write nothing, exactly as `--stdout` does — globally, and for the MCP server, which parses no CLI flags. See "Running without writing". |
| `ULTRASEARCH_CACHE_DIR` | `$TMPDIR/ultrasearch/cache` | Where the fetch cache lives. |
| `ULTRASEARCH_CACHE_TTL_MS` | 24h | Cache lifetime. `0` = always stale, always refetch. |
| `ULTRASEARCH_NO_WAYBACK` | unset | Set to disable the Wayback rescue for dead links. |
| `ULTRASEARCH_UA` | a desktop browser UA | Override the User-Agent scrapers send. |
| `ULTRASEARCH_MAX_ATTEMPTS` | 2 | Attempts per request (1-5). |
| `ULTRASEARCH_RETRY_MS` | 600 | Backoff between attempts. |
| `ULTRASEARCH_PAGE_DELAY_MS` | 350 | Pause between result pages of one engine. |
| `ULTRASEARCH_POLITE_DELAY_MS` | 400 | Pause between a scholarly API's per-variant calls. |

> **The last four are politeness, not performance.** They exist so tests and CI
> can run fast offline. Zeroing them against the live web hammers free services
> and gets the host rate-limited or blocked. **Never lower them on a real run.**

## Running without writing (`--stdout`)

For a planning phase, a read-only sandbox, or any harness that forbids writes.
`--stdout` on any command — or `ULTRASEARCH_NO_WRITE=1` in the environment —
makes the engine write **nothing at all**: not the dossier, not the report
files, not the fetch cache. What it would have written goes to stdout instead.

| Command | Under `--stdout` |
|---|---|
| `gather` | `DOSSIER.md`, then every source's full extract, delimited by `===== <path> =====` |
| `brainstorm` | `BRAINSTORM.md` |
| `plan` | its JSON payload, unchanged; the `<RUN>/q#` dirs stay in it as hints but are not created |
| `render` | `index.md` only — `index.html` is never built, since its value is being a file you open |
| `search` · `modes` · `check` | nothing changes; they already wrote nothing |
| `merge` · `fetch` · `relink` · `verify` · `orchestrate` | **exit 2** — see Exit codes |

Add `--json` for the parse-safe form: `{ dir: null, manifest, artifacts: { "<path>": "<content>" } }`,
carrying every artifact including `sources.json` and `manifest.json`. The plain
`=====` delimiter is for reading, not parsing — fetched page text is untrusted
(SKILL.md I2) and can contain any line at all.

**What you lose: the `check` gate.** `check` validates a `REPORT.md` against a
`sources.json`, and neither can exist here. `DOSSIER.md` says so in its own
grounding-rules section rather than threatening a gate that cannot run. Cite
`[S#]` inline from the streamed extracts and claim nothing beyond them.

This is not a sandbox. It stops the writes ultrasearch performs; it cannot stop
a caller from redirecting stdout into a file.

## Optional local containers

Everything ultrasearch talks to is keyless; two of them can be **self-hosted**,
and both live behind a docker compose profile. A bare `docker compose up -d`
starts **nothing**.

| Profile | Brings up | Cost | What it buys |
|---|---|---|---|
| `search` | SearXNG on `:8888` | one small container | The `searxng` discovery backend (`--searxng http://localhost:8888`). |
| `extract` | Firecrawl + playwright/redis/rabbitmq/postgres on `:3002` | ~3 GB images, ~4 GB RAM | Browser-rendered main-content markdown instead of the built-in HTML stripper, plus the `firecrawl` search backend. |

```bash
docker compose --profile search up -d --wait                    # discovery only
docker compose --profile search --profile extract up -d --wait  # + extraction
```

Firecrawl needs no configuration: the default base is `http://localhost:3002`,
and a memoised 2s probe decides per process whether it is there. When it is not,
every extraction uses the built-in reader exactly as before. `docker/firecrawl/README.md`
has the smoke tests and the tunables.

## Offline and deterministic runs

- `--backends fixture` gives a canned 3-source dossier about rate limiting with
  **no network at all** — the way to rehearse the whole
  `plan → orchestrate → merge → verify → check` chain, or to test a harness
  integration, without touching the web.
- `search --backend generic --url "https://a,https://b"` fetches exact pages,
  prints them, and writes nothing.
- `render` output is byte-identical for the same dossier (no timestamps in the
  body), so rendered reports diff cleanly.

## Machine-readable output

`--json` works on `check`, `modes`, `plan`, `verify`, `brainstorm`, `search` and
`gather`. Two worth knowing:

- `orchestrate --run <RUN> --list` → per-phase `{ ready, items, ids, worklist,
  prerequisite }` without emitting anything. The cheap "can I fan out yet?" probe.
- `check --run <dir> --json` → the full `CheckResult`, including `dangling`,
  `unmarkedUnsourced`, `numeralIssues` and the semantic verdict summary.

## Retrieval quality signals

`gather` surfaces four deterministic signals. React to each rather than writing
around them:

| Signal | Where | What to do |
|---|---|---|
| **Thin dossier** | `DOSSIER.md` banner, manifest `recallFloor`, `check` warning | Enrich with `fetch --url` before writing. |
| **Under-covered terms** | `DOSSIER.md` banner, manifest `coverage.under`, the `weak:` line, `check` warning | These question terms are barely in the sources. Search them yourself and ingest, or state the gap under "Open questions". |
| **`⚠ snippet only`** | per source in `DOSSIER.md` | The page fetch failed; only the search snippet is on file. Re-`fetch` it or find a primary source — don't lean on it. |
| **Contradiction** | `check --semantic` warning + an HTML panel | Cited sources disagree. Resolve it in the report; don't silently pick a side. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `gather` exits 1, 0 sources | Every keyless backend blocked or offline | Retry once with a different `--web-engine`; then bridge with your own WebSearch + `fetch --url`. Stop after two empty attempts and report the gap. |
| `searxng` backend skipped after a `docker compose up` | Every compose service is behind a profile now — a bare `up` starts nothing | `docker compose --profile search up -d --wait` |
| Firecrawl is up but nothing says so | The probe failed, or `ULTRASEARCH_FIRECRAWL` is `off` | `curl -s http://localhost:3002/` should answer. A run that used it says `Firecrawl cleaned N page(s)…` in the notes. |
| Extracts look truncated since enabling Firecrawl | Its markdown is richer, so it reaches the 4k/8k `--depth` cap sooner | Use `--depth deep` (uncapped extracts), or read `sources/S#.md` directly. |
| Thin dossier every time | Query too narrow, or a niche/commercial topic | Add `--queries` variants, raise `--web-breadth`/`--pages`, add `--seed-domains` for hosts you know. |
| `--seed-domains` / `--rounds` did nothing | `--backends` was also passed — it pins retrieval and voids them | Drop `--backends`. The run now says `IGNORED:` when this happens. |
| `check`: "No source citations found" | Every `[S#]` sits in the trailing `## Sources` appendix | Cite **in the body**. The appendix is rendered, not counted. |
| `check`: dangling `[S#]` | Cited a sub-run id after a merge, or invented one | Only MASTER ids resolve after `merge`. Re-cite from the master `DOSSIER.md`. |
| `check --semantic` always fails | No adjudicated `VERIFY.json` — it fails closed by design | Run `verify`, adjudicate, `verify --apply`. Or drop `--semantic` and use the mechanical gate. |
| Round-2 verdicts corrupt | `verify` renumbers claim ids; `--apply <dir>` folds **every** `*verdict*.json` | Delete or archive the previous round's verdict files **before** adjudicating a new round. |
| `index.md` isn't next to `index.html` | `render --run X --out Y` moves only the HTML | Copy it, or render without `--out`. |
| A cited figure isn't in the source | Numeral asserted but absent from the extract | `fetch` the page that carries it, re-cite, or flag it `[M]`. `check --strict-numerals` makes this fatal. |
| `fetch --url` refuses: "extracted to a … wall" | The host is throttling you (some serve a consent wall or a reCAPTCHA page as HTTP **200**) | Working as intended — a wall is not content. Retry later, pace the run, or pass an endpoint that carries the same document: the text comes from there, a **page** is still what gets cited. |
| `fetch --url` refuses: "batches N ids" / "is a … query" | One URL listing many ids, or a search, is not one document | Pass the ids one at a time — one `S#` per document is what citation checking rests on. |
| `fetch --url` refuses: "names no document" | An endpoint whose payload carries no canonical link, DOI, arXiv id or PMID | Nothing citable can be derived from it — reconstruct it. Search for the record's title, then re-run with `--cite-url "<page>"`: the text still comes from the endpoint. |
| `check` warns: cited source points at an API endpoint | A raw endpoint got pinned as a source (a dossier gathered before this gate) | Run `relink --run <dir>`: it repairs every source whose stored text names its own document, and prints the rest. Then find each remaining page and `relink --id S# --url "<page>"`. |
| `check` warns: cited source extracted to a wall | The host was throttling when it was fetched | `relink` lists these too but cannot fix them — the text is missing, not just the link. Re-`fetch --url` them, or drop the claims resting on them. |
