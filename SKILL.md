---
name: ultrasearch
description: "Use when the user wants a thorough, citation-grounded recap of what the WEB says about a topic — not an answer from the model's training memory. Fans out keyless web search across many backends (SearXNG, DuckDuckGo, Wikipedia, the keyless StackExchange/Hacker News/GitHub APIs, and the scholarly arXiv/Crossref/OpenAlex/Semantic Scholar APIs), fetches + cleans + de-duplicates the pages into an evidence dossier, and has you write a tiered report (SUMMARY/REPORT/FULL) where every claim cites a fetched source [S#] — verified by `ultrasearch check` — plus a self-contained HTML report. Five modes tailor the sources and report shape: topic (general briefing), bug (debug an error via Stack Overflow/GitHub/HN), research (scholarly literature review with a BibTeX file), learn (a pedagogical lesson with glossary + exercises), startup (market/competitor/pricing research). Triggers: 'research <topic>', 'what does the web say about X', 'summarize everything about X', 'deep dive on X', 'debug/why am I getting <error>', 'literature review of X', 'teach me / help me learn X', 'market research for <idea>', 'competitors of X', 'is there prior art / papers on X'. The web-facing sibling of ultradoc."
license: MIT
metadata:
  version: 1.2.0
---

# ultrasearch — recap the web, grounded not guessed

`ultrasearch` answers a topic or question by **retrieving real web sources and
reasoning over them**, not from training memory. The deterministic engine
(`scripts/ultrasearch.mjs`, zero-dependency Node) does the searching, fetching
and de-duplicating **with code**; your job is to read the retrieved sources and
write a precise, **cited**, tiered report. Every factual claim must point to a
fetched source. This is enforced: `ultrasearch check` fails if any citation is
dangling or any claim in REPORT/FULL is unsourced and unflagged.

> **The core rule:** do not answer from your own knowledge of the topic. Answer
> **only** from the sources `ultrasearch` retrieves. If you must add your own
> background knowledge, FLAG it as unverified — end the sentence with `[M]` or
> put it in a `> [model-hint]` blockquote. Never disguise memory as a source.

## The script

One committed, dependency-free bundle: `node scripts/ultrasearch.mjs <command>`.
No `npm install`, no API keys. Run `--help` for the full surface. Key commands:

- `gather --q "<topic>" [--mode <m>] [--depth <d>] [--out <dir>]`
  Fan out the mode's keyless backends, fetch + clean + de-dupe, and write an
  **evidence dossier** (`sources.json`, `sources/S#.md`, `DOSSIER.md`,
  `manifest.json`) to a run folder. Modes: `topic` (default) · `bug` ·
  `research` · `learn` · `startup`. Depths: `summary` · `standard` · `deep`.
- `search --backend <kind> --q "<query>"` — drill ONE backend, print results
  (writes nothing). Use to probe a thin area.
- `fetch --url <u> --out <dir>` (alias `add-source`) — ingest a URL **you** found
  with your own WebSearch into the dossier; prints the new `S#`. This is the
  bridge between the harness's WebSearch and the dossier.
- `render --run <dir>` — render SUMMARY/REPORT/FULL.md (+ glossary) into a
  self-contained `index.html` (embedded CSS, TOC, clickable `[S#]` citations).
- `check --run <dir>` — validate citation grounding. Exit non-zero ⇒ ungrounded.
- `modes [--json]` — list modes and their backend profiles.

## Workflow

You are invoked once and expected to return a grounded, cited report folder. Do
not hand control back mid-retrieval.

1. **Resolve intent.** Restate the question. Pick a `--mode` (default `topic`;
   use `bug` for an error, `research` for a literature review, `learn` to teach
   it, `startup` for market research) and a `--depth` (`standard` default;
   `deep` for an exhaustive sweep that also runs the mode's deep-only backends).

2. **Gather.** Run:
   ```
   node scripts/ultrasearch.mjs gather --q "<precise question>" --mode <m> --depth <d>
   ```
   It prints the dossier path. If a local SearXNG instance is up, pass
   `--searxng <url>`. The keyless backends are best-effort — some may be
   rate-limited or empty, and the engine records that honestly in the notes.
   You can steer recall with `--queries "phrasing one|phrasing two|exact term"`
   (pipe-separated) — your own query variants override the built-in planner and
   fan out across the multi-query backends.

3. **Read the dossier.** Open `DOSSIER.md` in the run folder: it lists every
   source with an id (`[S1]`, `[S2]`, …), a snippet, and the path to its cleaned
   full text in `sources/S#.md`. Read the actual source text. Note coverage gaps
   and triage off-topic sources.

4. **Enrich the thin areas (the bridge).** Retrieval is recall-oriented and the
   keyless backends miss things. Use **your own WebSearch** for authoritative
   primary sources, the angles the dossier is thin on, and anything the user
   specifically asked about. For each good URL, ingest it:
   ```
   node scripts/ultrasearch.mjs fetch --url "<url>" --out <dir>
   ```
   It fetches, cleans, assigns the next `S#`, and returns the id so you can cite
   it. Repeat until coverage is solid (more for `deep`). See
   `references/research-playbook.md`.

5. **Write the three tiers.** In the run folder, write:
   - `SUMMARY.md` — the TL;DR (top of the mode template, a few sentences each).
   - `REPORT.md` — the full mode template (headings shown in `DOSSIER.md` and
     `references/report-templates.md`).
   - `FULL.md` — exhaustive: use every relevant source; add an "Open questions /
     contradictions" section.
   **Cite every factual claim** with `[S#]` (e.g. `Token buckets allow bursts up
   to the bucket size [S2].`). Flag any of your own background knowledge with
   `[M]` or a `> [model-hint]` blockquote — see `references/citation-format.md`.
   For `research` mode, the engine has already written `refs.bib`; reference it.
   For `learn` mode, also write `glossary.md` (term — definition, one per line).

6. **Render & check.**
   ```
   node scripts/ultrasearch.mjs render --run <dir>   # → index.html
   node scripts/ultrasearch.mjs check  --run <dir>
   ```
   `check` fails on a dangling `[S#]` or an unmarked unsourced claim in
   REPORT/FULL. Fix the citations (or `fetch` more sources) and re-run until it
   passes. SUMMARY is checked leniently (a digest needn't cite every line).

7. **Present.** Give the user the SUMMARY, the path to the run folder and
   `index.html`, the source count, and any gaps or contradictions you found.

## Modes & depth

- `topic` — Wikipedia + general web → a neutral briefing.
- `bug` — Stack Overflow + GitHub issues + Hacker News + changelogs → cause +
  ranked candidate fixes + workarounds.
- `research` — arXiv + Crossref + OpenAlex + Semantic Scholar + Europe PMC
  (+ PubMed at `deep`) → a literature review + `refs.bib` (BibTeX).
- `learn` — general web + docs → objectives, glossary, lesson, worked examples,
  exercises; the richest HTML.
- `startup` — general web + community → market sizing, competitors, pricing, GTM.

`--depth deep` keeps more sources and runs each mode's deep-only backends; tiers
are always all three. The engine handles recall for you: it expands the question
into query variants, re-ranks sources by how well their text covers the
question, dedupes the same work across scholarly backends, and retries once on
throttling. `--since <date>` restricts date-capable backends; `--web-engine`
pins the general-web discovery layer (default `auto` runs a keyless fallback
cascade: SearXNG → DuckDuckGo → DuckDuckGo Lite → Mojeek → Marginalia, stopping
at the first engine that returns enough — so recall survives one engine blocking).
`--rounds 2` adds a gap-driven follow-up web search for question terms the first
pass under-covered; `--concurrency` tunes page-fetch parallelism. PDFs (incl.
arXiv papers) are read for full text, not just the abstract.

## References

- `references/research-playbook.md` — how to pick a mode, query, enrich, iterate.
- `references/citation-format.md` — the citation grammar `check` enforces.
- `references/report-templates.md` — the per-mode report skeletons.
- `references/modes.md` — mode → backend profile + extras mapping.
- `references/backend-apis.md` — the keyless endpoints + rate limits.
- `references/web-discovery.md` — the layered keyless web search + WebSearch bridge.
- `references/html-rendering.md` — what `render` produces and how citations map.
