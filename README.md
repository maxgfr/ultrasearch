# ultrasearch

**Recap everything the web says about a topic — grounded, not guessed.**

`ultrasearch` is a [skills.sh](https://skills.sh) agent skill. Give it a
topic or question and it fans out **keyless web search across many backends**,
fetches and de-duplicates the pages into an **evidence dossier**, then has the
agent write a **citation-checked research report** in two tiers (a TL;DR
`SUMMARY` and a complete `REPORT`) plus a **self-contained HTML** (and portable
markdown) you can open and read.

It's the web-facing sibling of [`ultradoc`](https://github.com/maxgfr/ultradoc):
same machine (one committed, zero-dependency Node bundle; deterministic
retrieval; a `check` command that fails on ungrounded claims), pointed at the
open web instead of a git repo.

```bash
npx skills add maxgfr/ultrasearch
```

> Already installed? Re-run `npx skills add maxgfr/ultrasearch` to pull the
> latest engine + skill description.

## Why

Ask a model about a topic and it answers from stale training memory. ultrasearch
**retrieves first**: it searches, fetches real pages, and writes each source's
cleaned text to disk. The agent then writes an answer where **every factual
claim cites a fetched source** (`[S3]`), and `ultrasearch check` fails the report
if any citation is dangling or any claim is unsourced. The model may still add
its own background knowledge — but only as a **clearly flagged "model hint"**
(`> [model-hint] …`), never disguised as a source.

## What you get

A run writes an output folder:

```
<out>/
  manifest.json   run metadata (question, mode, depth, backends, source count)
  sources.json    the dossier: S1…Sn with url, title, backend, trust, extract path
  sources/S#.md   cleaned, readable text of each fetched source
  DOSSIER.md      model-facing digest + the template + citation rules
  SUMMARY.md      TL;DR tier            ┐ written by the agent, cited [S#]
  REPORT.md       complete report tier  ┘
  glossary.md     (learn mode)   refs.bib (research mode)
  index.html      self-contained HTML report (embedded CSS + TOC), easy to read
  index.md        consolidated markdown report (all tiers + sources), portable
```

> `render` writes **both** `index.html` and `index.md` by default (`--no-html` /
> `--no-md` skip either).

### …or nothing at all

For a planning phase, a read-only sandbox, or any harness that forbids writes,
add `--stdout` (or set `ULTRASEARCH_NO_WRITE=1`). Nothing reaches the disk — not
the dossier, not the fetch cache — and what would have been written is streamed
instead:

```bash
ultrasearch gather --q "what is rate limiting" --stdout   # DOSSIER.md + every source extract
```

`brainstorm`, `plan` and `render` stream their own artifacts the same way;
`--json` gives the parse-safe `{ dir: null, manifest, artifacts }` form. Commands
whose product **is** a file for a later process — `merge`, `fetch`, `verify`,
`orchestrate` — exit 2 rather than pretend. Note the trade: `check` validates a
`REPORT.md` against a `sources.json`, so with no files there is no mechanical
grounding gate. See `skills/ultrasearch/references/operations.md`.

## Five modes

Each mode is a **report template** + a **backend-priority profile**:

| Mode | For | Favors |
|------|-----|--------|
| `topic` *(default)* | a general briefing on any subject | Wikipedia + general web |
| `bug` | debugging an error / symptom | Stack Overflow, GitHub issues, Hacker News, changelogs |
| `research` | a scholarly literature review | arXiv, Crossref, OpenAlex, Semantic Scholar, Europe PMC, PubMed, dblp (+ `refs.bib`) |
| `learn` | learning a topic from scratch | general web + docs → glossary, lesson, exercises, rich HTML |
| `startup` | market research for a product/idea | general web → competitors, market sizing, pricing, GTM |

## How it's used (the agent's loop)

> Paths below are relative to a repo checkout. An **installed** skill runs from
> its own folder, so the agent substitutes an absolute `<skill-dir>/` prefix
> (`~/.claude/skills/ultrasearch/…`) — see `SKILL.md`.

```bash
# 1. Sweep — what to search, and how wide
node scripts/ultrasearch.mjs queries --q "how does HTTP rate limiting work" \
  --mode topic --depth standard
#    The agent runs its OWN WebSearch once per angle and pools every hit into
#    /tmp/rl-hits.json:  [{"url":"…","title":"…","snippet":"…"}, …]

# 2. Retrieve — fetch, clean, rank and de-duplicate every page into the dossier
node scripts/ultrasearch.mjs gather --q "how does HTTP rate limiting work" \
  --mode topic --depth standard --web-results /tmp/rl-hits.json --out /tmp/rl
#    add --search full to fuse the keyless engines in on top

# 3. The agent reads DOSSIER.md and tops up the gaps — a whole round, one process
node scripts/ultrasearch.mjs ingest --run /tmp/rl --web-results /tmp/rl-round2.json

# 4. The agent writes SUMMARY.md / REPORT.md, citing every claim [S#]

# 5. Render + verify grounding
node scripts/ultrasearch.mjs render --run /tmp/rl     # → index.html
node scripts/ultrasearch.mjs check  --run /tmp/rl     # exit≠0 if ungrounded
```

## Deep research tier (opt-in)

For an exhaustive, *verified* deep-dive, ultrasearch runs an agentic loop instead
of a single pass — **decompose → fan out → merge → adversarially verify →
loop-until-dry** — grafted onto the same keyless engine. Every step is a plain
CLI call, so it works on any harness; parallel subagents are an *optimization*,
never a requirement (full playbook + the copy-pasteable subagent contract:
[`references/deep-research-playbook.md`](skills/ultrasearch/references/deep-research-playbook.md)).

```bash
# decompose into sub-questions, each with a deterministic out dir to gather into
node scripts/ultrasearch.mjs plan   --q "<question>" --run-root /tmp/deep
# fan out one `gather --depth deep` per sub-question (parallel subagents or a loop), then:
node scripts/ultrasearch.mjs merge  --runs "/tmp/deep/q1,/tmp/deep/q2" --master /tmp/deep/master
# write the tiers against the master, then verify every claim against its source:
node scripts/ultrasearch.mjs verify --run /tmp/deep/master [--shards N --shard I]  # one skeptic per shard
node scripts/ultrasearch.mjs verify --apply <verdicts|dir> --run /tmp/deep/master
node scripts/ultrasearch.mjs check  --semantic --require-verify --run /tmp/deep/master   # exit gate: fails on refuted/unsupported/unverified
```

`check --semantic` also surfaces **contradictions** — claims whose cited sources
disagree. Retrieval flags two more quality signals to act on: a **thin dossier**
(too few on-topic sources — `check --min-sources N` enforces a floor) and
**snippet-only** sources (the page fetch failed, so only the search snippet is on
file, marked `⚠ snippet only`).

## Optional self-hosted containers

Two things can run locally, both keyless, both optional. The compose file is
embedded in the engine and written out on demand, so these work from any install
— there is nothing to clone and no file to find:

```bash
ultrasearch searxng up      # SearXNG on :8888          (compose profile `search`)
ultrasearch firecrawl up    # + Firecrawl on :3002      (+ profile `extract`)
ultrasearch doctor          # what is actually available right now
```

Both are **auto-detected on localhost** and used without any flag, each behind a
2s availability probe so an absent one costs a single refused connection. Because
they are skipped in *silence*, every run ends with a `Helpers:` line saying what
they actually did — a container that is up but contributing nothing is exactly
the case worth seeing, and `ultrasearch doctor` says why.

- **SearXNG** (`--profile search`) backs the `searxng` discovery backend. Used on
  `http://localhost:8888` with no flag at all (`--searxng <url>` /
  `ULTRASEARCH_SEARXNG` to point elsewhere, `off` to disable).
- **PDFs** get their own extractor ladder — `npx @firecrawl/pdf-inspector@1`, then
  `npx @firecrawl/anydoc@0.1` (the same conversion, but with a `darwin-x64` binary
  pdf-inspector lacks, so Intel Macs still read PDFs without Docker), then
  Firecrawl, then `pdftotext`, then the built-in reader — stopping at the first
  whose output passes a quality gate, and REFUSING rather than citing a PDF none
  of them could read. `ULTRASEARCH_NO_NPX=1` drops the npx rungs;
  `ULTRASEARCH_PDF_ENGINE=<rung>` pins one. A **scanned** PDF — no text layer at
  all, so every rung above fails — is rescued by a final OCR rung,
  [`copyable-pdf`](https://github.com/maxgfr/copyable-pdf) + `tesseract` when
  both are installed, budgeted at `ULTRASEARCH_OCR_MAX` documents per run. See
  [`references/backend-apis.md`](skills/ultrasearch/references/backend-apis.md).
- **Office documents** (`.docx`, `.pptx`, `.xlsx`, `.odt`, `.rtf`, `.epub`,
  `.csv`, …) are converted to Markdown by [`@firecrawl/anydoc`][anydoc], with
  Firecrawl as the fallback rung — and refused, with a reason, when neither can
  read them. These are ZIP and OLE containers, so the alternative is not a worse
  extract but a fabricated one: before this ladder a `.docx` entered the dossier
  as kilobytes of replacement characters, cited, and silently. Needs Node 20+;
  `ULTRASEARCH_DOC_ENGINE=none` disables it. The same converters back
  `ingest --files <p,...>`, which pins a local document into a dossier.

[anydoc]: https://github.com/firecrawl/anydoc
- **Firecrawl** (`--profile extract`) replaces the built-in regex HTML stripper
  with **browser-rendered main-content markdown**: better on nav/cookie chrome,
  and the only way a JS-rendered page yields text at all. It also *rescues* the
  consent-wall / anti-bot pages the junk detector would otherwise reduce to a
  snippet. No configuration — it is used when it answers on
  `http://localhost:3002` and silently skipped when it does not, so runs never
  fail because of it (`--firecrawl <url>` / `ULTRASEARCH_FIRECRAWL`, `off` to
  disable). Costs ~3 GB of images and ~4 GB of RAM. The compose file
  and its env ship inside the vendored engine and are written out on first use
  (`ultrasearch firecrawl up`); there is no `docker/` directory in this repo.

The stack is **shared with the sibling skills** (ultrasearch, construct,
ultradoc): one compose project, one set of containers, one set of volumes. They
used to define three separate projects on the same host ports, so only one could
be up at a time — starting a second failed on the port *after* leaving its
sidecars running. Bringing it up from any of them now targets the same
containers, so the second is a no-op and the RAM is paid once.

Upgrading from a version with per-skill container names? Remove the old ones
once — this file can no longer stop them, and they still hold the ports:

```bash
docker rm -f $(docker ps -aq --filter name='^(ultrasearch|construct|ultradoc)-')
```

## Your WebSearch is the engine

Discovery has two lanes, and the first one is the agent's own **WebSearch** —
the best index in the pipeline, and the only one needing neither a container nor
a scrape. `queries` sizes the sweep (2 · 4 · 8 distinct queries by depth) and
names the angles to cover; the agent runs them and pools the hits into
`--web-results`. The engine then does what a model cannot: fetch every page,
strip it, rank it, de-duplicate it, and refuse a consent wall.

Those hits get **no trust privilege** — every page is read like any other, and
there is no hostname table at all: `trust` reflects only the route a source
arrived by. What they do get is that **nothing is thrown away**. There is no
source quota, and `--max-sources` is an opt-in fetch budget that is unset by
default, so a page the agent deliberately chose is never dropped to make room.

`--search max` is the ceiling: everything below, plus Firecrawl's own `/search`
in discovery, every recall knob at its limit and `--depth deep`. It wants the
whole container stack up, warns before the run when it is not, and records what
it lost. It buys **recall, not precision** — excellent on `research`, noisier on
a heavily-blogged `topic`.

The second lane is the free fallback cascade, behind `--search full`:
**SearXNG** (local, optional) → **DuckDuckGo** → **DuckDuckGo Lite** → **Mojeek**
→ **Marginalia**, fused by breadth. These are scrapers and free APIs — they
rate-limit and go empty — so they amplify the first lane rather than replace it.
`--search light` (the default once you pass `--web-results`) skips them entirely:
no container, no scraping, nothing to rate-limit. A harness with no WebSearch
tool passes no hits and keeps the cascade as before.

Mode-specific backends run in both profiles: Wikipedia, the keyless
StackExchange (multi-site) / Hacker News / GitHub APIs, and the scholarly APIs
(arXiv / Crossref / OpenAlex / Semantic Scholar / Europe PMC / PubMed / dblp) —
all keyless.

Each run plans **query variants** and fans backends out across them, re-ranks
sources by how well their fetched text covers the question, dedupes the same
work across scholarly backends by DOI/arXiv id, and retries once on throttling
— so you get broad, relevant, de-duplicated coverage. A dead link (404/410/…) is
rescued from the **Wayback Machine** before it's dropped, and an on-disk fetch
cache (**on by default**, `--no-cache` to disable) is shared across processes, so
the deep tier's per-sub-question fan-out reuses pages instead of re-fetching
them. It is keyed by canonical URL *and* locale, and only successful extractions
are stored.

Each run also reports what retrieval could **not** do: a thin-dossier flag, the
question terms the sources barely cover, per-source `⚠ snippet only` markers, and
— when `--backends` pins the retrieval set — an explicit note naming the flags
that override silently voided.

## Commands

- `queries` — the WebSearch worklist: how many distinct queries to run for this
  depth, and which angles to cover. Start here.
- `gather` — the main entrypoint: fetch → rank → dedupe → write dossier, driven
  by `--web-results` (your hits) and sized by `--search light|full`.
- `ingest` — fold a whole round of URLs into a dossier in ONE process.
- `search --backend <kind>` — drill one backend (debugging retrieval).
- `fetch` / `add-source` — ingest a single URL into a dossier.
- `render --run <dir>` — render the report tiers to a self-contained `index.html`.
- `check --run <dir>` — validate citation grounding (`--semantic` folds in the
  verify verdicts + contradictions; `--min-sources N` fails a too-thin dossier).
- `modes` — list modes and their backend profiles.
- `brainstorm` — probe a vague ask and propose angles + clarifying questions
  before committing to a run.
- `plan` / `merge` / `verify` — the deep-research tier (decompose → merge →
  adversarially verify; `verify --shards` for parallel skeptics).
- `orchestrate` — emit the run's multi-agent fan-out (one launchable workflow per
  ready phase, the per-role dispatch contracts, and a sequential `RUNBOOK.md`).
- `mcp` — serve all of the above over the Model Context Protocol (below).

Run `node scripts/ultrasearch.mjs --help` for the full surface, and see
[`DOCUMENTATION.md`](DOCUMENTATION.md) for the architecture.

## Use it as an MCP server

The skill shells out to the CLI and parses its output. An MCP server skips both:
your agent calls ultrasearch as typed tools, with JSON schemas in and structured
results out. Same engine, same cache, no wrapper.

```bash
# stdio — the default, and what Claude Code / Claude Desktop / Cursor expect
claude mcp add ultrasearch -- node /abs/path/to/scripts/ultrasearch.mjs mcp

# or over HTTP, on loopback
node scripts/ultrasearch.mjs mcp --transport http --port 7339
claude mcp add --transport http ultrasearch http://127.0.0.1:7339/mcp
```

```jsonc
// Claude Desktop takes stdio servers only — a remote URL here will not work.
{ "mcpServers": { "ultrasearch": { "command": "node", "args": ["/abs/path/to/scripts/ultrasearch.mjs", "mcp"] } } }
// Cursor, HTTP:
{ "mcpServers": { "ultrasearch": { "url": "http://127.0.0.1:7339/mcp" } } }
```

It serves all three MCP primitives, because a skill is three things: the engine
(**tools**), the method (**prompts**), and the documentation the method refers
to (**resources**). A client given only the tools has to invent the rest.

### Tools

Eleven tools. `ultrasearch_gather` is the one to reach for first:

| Tool | What it does |
|------|--------------|
| `ultrasearch_gather` | Fan out, fetch, dedupe → a dossier on disk; returns its directory |
| `ultrasearch_search` | One backend, ranked results, **writes nothing** — the cheap probe |
| `ultrasearch_fetch` | Ingest a URL you found yourself into a dossier as a citable `[S#]` |
| `ultrasearch_check` | The grounding gate: every `[S#]` must resolve |
| `ultrasearch_verify` | Claim↔source worklist for adversarial support-checking |
| `ultrasearch_render` | Dossier + report → self-contained `index.html` and `index.md` |
| `ultrasearch_plan` | Decompose a broad question into sub-questions |
| `ultrasearch_merge` | Union sub-dossiers, re-assigning `[S#]` ids to stay unique |
| `ultrasearch_brainstorm` | Probe a vague ask before committing to a run |
| `ultrasearch_modes` | What each mode is for and which backends it searches |
| `ultrasearch_read` | A file, or a line range, from a dossier |

Pass `--run <dir>` at startup to dedicate the server to one dossier — `run` then
becomes optional on every tool. There is no `--allow-write`: nothing here
deletes a dossier, and every write lands in a directory the caller named.

### Prompts — the workflow, not just the tools

| Prompt | Arguments | What it drives |
|--------|-----------|----------------|
| `research_topic` | `question`, `depth?` | gather → read every source → cited report → `ultrasearch_check` → render |
| `debug_error` | `error`, `context?` | `mode: bug` against StackOverflow/GitHub/HN, with the version caveat spelled out |
| `literature_review` | `question` | plan → gather per sub-question → merge → one review against the merged ids |

Each carries the invariant the skill exists for: the report says what the
**fetched sources** say, not what the model remembers.

### Resources — the skill's own documentation

`SKILL.md` and all nine `references/*.md` are served under `skill://`, read off
disk at request time — so a documentation fix reaches every client without a
rebuild.

Two things worth knowing:

- **`gather` defaults to `depth: standard` here, not `deep`.** A deep run is
  10-20 minutes and an MCP client will time out long before it returns, losing
  the run. Ask for `deep` explicitly when you mean it — the tool description
  states the wall-clock for each tier.
- **`ULTRASEARCH_NO_WRITE=1` applies here too.** `ultrasearch_gather`,
  `_brainstorm`, `_plan` and `_render` return their artifacts inline (`run` comes
  back `null`); `_fetch`, `_merge` and `_verify` return an error, since their
  product is a file a later call would read. Every tool then advertises
  `readOnlyHint: true`.
- **The HTTP transport binds `127.0.0.1` and refuses anything else** unless you
  pass `--allow-remote`. This server fetches arbitrary URLs; an exposed port is
  a fetch-anything primitive for whoever finds it. Browser `Origin`s are checked
  for the same reason.

## Security & trust boundary

ultrasearch is keyless and makes outbound HTTP requests to URLs chosen by the
agent (search-engine results and pages it elects to fetch), following redirects
— so a fetch can land on an internal/private address post-redirect. Treat the
host running it as able to reach the network it sits on. Parsing is size-capped
(responses are truncated before extraction) to bound memory, and the tool only
writes inside the `--out` directory — or, under `--stdout` /
`ULTRASEARCH_NO_WRITE=1`, nowhere at all. Run it where reaching arbitrary URLs,
including internal ones, is acceptable. Fetched page text is **untrusted input**:
the agent is instructed to quote and cite it, never to obey instructions embedded
inside a page (prompt injection).

## License

MIT © maxgfr
