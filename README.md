# ultrasearch

**Recap everything the web says about a topic — grounded, not guessed.**

`ultrasearch` is a [skills.sh](https://skills.sh) agent skill. Give it a
topic or question and it fans out **keyless web search across many backends**,
fetches and de-duplicates the pages into an **evidence dossier**, then has the
agent write a **citation-checked research report** in three sizes (TL;DR /
standard / exhaustive) plus a **self-contained HTML** you can open and read.

It's the web-facing sibling of [`ultradoc`](https://github.com/maxgfr/ultradoc):
same machine (one committed, zero-dependency Node bundle; deterministic
retrieval; a `check` command that fails on ungrounded claims), pointed at the
open web instead of a git repo.

```bash
npx skills add maxgfr/ultrasearch
```

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
  SUMMARY.md      TL;DR tier            ┐
  REPORT.md       standard tier         ├ written by the agent, cited [S#]
  FULL.md         exhaustive tier       ┘
  glossary.md     (learn mode)   refs.bib (research mode)
  index.html      self-contained HTML report (embedded CSS + TOC), easy to read
```

## Five modes

Each mode is a **report template** + a **backend-priority profile**:

| Mode | For | Favors |
|------|-----|--------|
| `topic` *(default)* | a general briefing on any subject | Wikipedia + general web |
| `bug` | debugging an error / symptom | Stack Overflow, GitHub issues, Hacker News, changelogs |
| `research` | a scholarly literature review | arXiv, Crossref, OpenAlex, Semantic Scholar, Europe PMC, PubMed (+ `refs.bib`) |
| `learn` | learning a topic from scratch | general web + docs → glossary, lesson, exercises, rich HTML |
| `startup` | market research for a product/idea | general web → competitors, market sizing, pricing, GTM |

## How it's used (the agent's loop)

```bash
# 1. Retrieve — fan out keyless backends, write the dossier
node scripts/ultrasearch.mjs gather --q "how does HTTP rate limiting work" \
  --mode topic --depth standard --out /tmp/rl

# 2. The agent reads DOSSIER.md, enriches thin areas with its own WebSearch:
node scripts/ultrasearch.mjs fetch --url "https://…" --out /tmp/rl    # → prints new S#

# 3. The agent writes SUMMARY.md / REPORT.md / FULL.md, citing every claim [S#]

# 4. Render + verify grounding
node scripts/ultrasearch.mjs render --run /tmp/rl     # → index.html
node scripts/ultrasearch.mjs check  --run /tmp/rl     # exit≠0 if ungrounded
```

## Keyless, no API keys

Discovery is layered and free, mirroring ultradoc:
**SearXNG** (local, optional) → **DuckDuckGo** (HTML scrape) → the agent's own
**WebSearch** (URLs fed back via `fetch --url`). Mode-specific backends add
Wikipedia, the keyless StackExchange (multi-site) / Hacker News / GitHub APIs,
and the scholarly APIs (arXiv / Crossref / OpenAlex / Semantic Scholar /
Europe PMC / PubMed) — all keyless.

Each run plans **query variants** and fans backends out across them, re-ranks
sources by how well their fetched text covers the question, dedupes the same
work across scholarly backends by DOI/arXiv id, and retries once on throttling
— so you get broad, relevant, de-duplicated coverage.

## Commands

- `gather` — the main entrypoint: search → fetch → dedupe → write dossier.
- `search --backend <kind>` — drill one backend (debugging retrieval).
- `fetch` / `add-source` — ingest a URL into a dossier (the WebSearch bridge).
- `render --run <dir>` — render the report tiers to a self-contained `index.html`.
- `check --run <dir>` — validate citation grounding.
- `modes` — list modes and their backend profiles.

Run `node scripts/ultrasearch.mjs --help` for the full surface, and see
[`DOCUMENTATION.md`](DOCUMENTATION.md) for the architecture.

## License

MIT © maxgfr
