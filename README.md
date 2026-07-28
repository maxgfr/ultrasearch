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
# 1. Retrieve — fan out keyless backends, write the dossier
node scripts/ultrasearch.mjs gather --q "how does HTTP rate limiting work" \
  --mode topic --depth standard --out /tmp/rl

# 2. The agent reads DOSSIER.md, enriches thin areas with its own WebSearch:
node scripts/ultrasearch.mjs fetch --url "https://…" --out /tmp/rl    # → prints new S#

# 3. The agent writes SUMMARY.md / REPORT.md, citing every claim [S#]

# 4. Render + verify grounding
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

Two things can run locally, both keyless, both optional, both behind a docker
compose **profile** (a bare `docker compose up -d` starts nothing):

```bash
docker compose --profile search up -d --wait                    # SearXNG on :8888
docker compose --profile search --profile extract up -d --wait  # + Firecrawl on :3002
```

- **SearXNG** (`--profile search`) backs the `searxng` discovery backend —
  `--searxng http://localhost:8888` or `ULTRASEARCH_SEARXNG`.
- **Firecrawl** (`--profile extract`) replaces the built-in regex HTML stripper
  with **browser-rendered main-content markdown**: better on nav/cookie chrome,
  and the only way a JS-rendered page yields text at all. It also *rescues* the
  consent-wall / anti-bot pages the junk detector would otherwise reduce to a
  snippet. No configuration — it is used when it answers on
  `http://localhost:3002` and silently skipped when it does not, so runs never
  fail because of it (`--firecrawl <url>` / `ULTRASEARCH_FIRECRAWL`, `off` to
  disable). Costs ~3 GB of images and ~4 GB of RAM; see
  [`docker/firecrawl/README.md`](docker/firecrawl/README.md).

## Keyless, no API keys

Discovery is a layered, free fallback cascade, mirroring ultradoc:
**SearXNG** (local, optional) → **DuckDuckGo** → **DuckDuckGo Lite** → **Mojeek**
→ **Marginalia** — it stops at the first engine that returns enough, so recall
survives one engine blocking — then the agent's own **WebSearch** (URLs fed back
via `fetch --url`). Mode-specific backends add
Wikipedia, the keyless StackExchange (multi-site) / Hacker News / GitHub APIs,
and the scholarly APIs (arXiv / Crossref / OpenAlex / Semantic Scholar /
Europe PMC / PubMed / dblp) — all keyless.

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

- `gather` — the main entrypoint: search → fetch → dedupe → write dossier.
- `search --backend <kind>` — drill one backend (debugging retrieval).
- `fetch` / `add-source` — ingest a URL into a dossier (the WebSearch bridge).
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

Run `node scripts/ultrasearch.mjs --help` for the full surface, and see
[`DOCUMENTATION.md`](DOCUMENTATION.md) for the architecture.

## Security & trust boundary

ultrasearch is keyless and makes outbound HTTP requests to URLs chosen by the
agent (search-engine results and pages it elects to fetch), following redirects
— so a fetch can land on an internal/private address post-redirect. Treat the
host running it as able to reach the network it sits on. Parsing is size-capped
(responses are truncated before extraction) to bound memory, and the tool only
writes inside the `--out` directory. Run it where reaching arbitrary URLs,
including internal ones, is acceptable. Fetched page text is **untrusted input**:
the agent is instructed to quote and cite it, never to obey instructions embedded
inside a page (prompt injection).

## License

MIT © maxgfr
