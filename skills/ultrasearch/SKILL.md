---
name: ultrasearch
description: "Use when the user wants a thorough, citation-grounded recap of what the WEB says — not the model's training memory. Fans out keyless web + scholarly-API search, fetches + de-dupes pages into a dossier, and you write a tiered report (SUMMARY/REPORT/FULL) where every claim cites a fetched source [S#] — verified by `ultrasearch check` — plus an HTML report. Five modes: topic, bug (debug an error via Stack Overflow/GitHub/HN), research (lit review + BibTeX), learn (lesson + glossary), startup (market/competitor research). Triggers: 'research X', 'what does the web say about X', 'summarize everything about X', 'deep dive on X', 'debug/why am I getting <error>', 'literature review of X', 'teach me / help me learn X', 'market research for <idea>', 'competitors of X', 'is there prior art / papers on X'. Opt-in deep tier decomposes the question, merges dossiers, and adversarially verifies each claim against its source (`verify` + `check --semantic`); triggers 'deep research on X', 'exhaustively research/verify X'."
license: MIT
metadata:
  version: 1.5.1
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

> **Search the audience's language; report in the user's.** If the question
> targets a non-English market (e.g. a startup idea for Germany), do the search in
> that language: translate your `--queries` and pass `--lang de` (and `--region`
> when the country differs from the language). Then **write the report in the
> language the user is talking to you in** — quote the foreign-language sources and
> gloss them. Search locale ≠ output language.

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
  self-contained `index.html` (embedded CSS, TOC, clickable `[S#]` citations,
  and — in deep mode — verdict badges + the sub-question tree) **and**, by
  default, a consolidated `index.md` (all tiers + sources, a portable markdown
  deliverable — named `index.md`, not `report.md`, so it can't clash with the
  `REPORT.md` tier on case-insensitive filesystems). `--no-md` / `--no-html` skip either.
- `check --run <dir> [--semantic] [--min-sources <n>]` — validate citation
  grounding. Exit non-zero ⇒ ungrounded. `--semantic` also fails on a claim its
  cited source does not support (folds in `verify`'s verdicts) and reports
  contradictions; `--min-sources <n>` fails a too-thin dossier.
- `modes [--json]` — list modes and their backend profiles.

**Deep research tier** (the agentic loop — see `references/deep-research-playbook.md`):

- `plan --q "<question>" [--mode <m>] [--subquestions "a|b|c"] [--run-root <dir>]`
  — decompose the question into sub-questions (JSON) to fan out on. With
  `--run-root` each sub-question carries a deterministic `out` dir (`<dir>/q1…`),
  so you can dispatch one `gather` per sub-question **without parsing stdout**.
- `merge --runs "<d1,d2,…>" --master <dir>` — union the sub-dossiers into one
  master dossier with **stable `[S#]` ids** (re-fused + de-duplicated).
- `verify --run <dir> [--shards <n> --shard <i>]` then `verify --apply <files>` —
  emit a claim↔source worklist (or just shard `i` of it, one per skeptic
  subagent), then gate on refuted/unsupported claims and surface **contradictions**
  (claims whose own cited sources disagree). `--apply` takes one file, a comma
  list, or a directory (any `*verdict*.json` in it) — so parallel shards reassemble.

## Workflow

You are invoked once and expected to return a grounded, cited report folder. Do
not hand control back mid-retrieval.

1. **Resolve intent.** Restate the question. Pick a `--mode` (default `topic`;
   use `bug` for an error, `research` for a literature review, `learn` to teach
   it, `startup` for market research) and a `--depth` (`standard` default;
   `deep` for an exhaustive sweep that also runs the mode's deep-only backends).
   **Decide the search language/region** from the question or target market
   (German market → `--lang de --region de`); use `--region` separately only when
   the content language differs from the market.

2. **Gather.** Run:
   ```
   node scripts/ultrasearch.mjs gather --q "<precise question>" --mode <m> --depth <d>
   ```
   It prints the dossier path. If a local SearXNG instance is up, pass
   `--searxng <url>`. The keyless backends are best-effort — some may be
   rate-limited or empty, and the engine records that honestly in the notes.
   You can steer recall with `--queries "phrasing one|phrasing two|exact term"`
   (pipe-separated) — your own query variants override the built-in planner and
   fan out across the multi-query backends. **For a non-English search, translate
   those `--queries` into the target language yourself** and pass `--lang`/`--region`
   (the engine never translates) so every web backend searches the right locale.
   Pull deeper with `--pages <n>` (result pages per engine) and wider with
   `--web-breadth <n>` (engines fused); both default by depth.

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
   node scripts/ultrasearch.mjs render --run <dir>   # → index.html + index.md
   node scripts/ultrasearch.mjs check  --run <dir>
   ```
   `render` always writes both a self-contained `index.html` and a consolidated
   `index.md` (the markdown deliverable, in the report's language).
   `check` fails on a dangling `[S#]` or an unmarked unsourced claim in
   REPORT/FULL. Fix the citations (or `fetch` more sources) and re-run until it
   passes. SUMMARY is checked leniently (a digest needn't cite every line).

7. **Present.** Give the user the SUMMARY, the path to the run folder,
   `index.html` and `index.md`, the source count, and any gaps or contradictions
   you found.

## Deep research mode (the agentic tier)

When the user wants an exhaustive, *verified* deep-dive — they say "deep
research", "exhaustively research/verify X", or it is a high-stakes briefing —
run the multi-agent loop instead of the single pass. It grafts **decompose →
parallel fan-out → adversarial verification → loop-until-dry** onto the same
keyless engine. Every step is a plain CLI call, so it works on any harness;
parallel subagents are an *optimization*, never a requirement. Full playbook:
`references/deep-research-playbook.md`.

1. **Decompose.** `node scripts/ultrasearch.mjs plan --q "<question>" --mode <m> --run-root <dir>`
   prints sub-questions (JSON, each with ready `queries` **and an `out` dir** under
   `<dir>`). Review them; augment or replace with your own via
   `--subquestions "facet a|facet b|facet c"` when you know the domain better.

2. **Fan out — one `gather` per sub-question.** If your harness has parallel
   subagents, dispatch one per sub-question (the **subagent contract** is in
   `references/deep-research-playbook.md`); otherwise loop sequentially (same
   commands, identical artifacts). Use each sub-question's own `out` dir so you
   know every sub-run path up front:
   ```
   node scripts/ultrasearch.mjs gather --q "<sub-question>" --queries "<its queries>" \
     --mode <m> --depth deep --out <its out dir>
   ```
   then enriches thin areas with its own WebSearch + `fetch` (step 4 above). A
   sub-dossier under the recall floor is flagged in its `DOSSIER.md` — enrich it
   before it feeds the merge.

3. **Merge.** Union the sub-dossiers into one master with stable ids:
   ```
   node scripts/ultrasearch.mjs merge --runs "<run1,run2,…>" --master <masterDir> \
     --q "<original question>" --mode <m>
   ```
   From here, **cite only the MASTER `[S#]` ids** — sub-run ids all restart at S1.

4. **Write the tiers** against the master dossier (SUMMARY/REPORT/FULL), exactly
   as in the standard workflow — every claim `[S#]`, your own knowledge `[M]`.

5. **Verify (adversarial).** `node scripts/ultrasearch.mjs verify --run <masterDir>`
   writes a claim↔source worklist (`VERIFY.todo.json` + `VERIFY.md`). For each
   pair, open the cited `sources/S#.md` and judge whether it actually SUPPORTS the
   claim — set `verdict` to supported · partial · refuted · unsupported (+ a short
   note). Save the filled file as `verdicts.json`. **In parallel:** run
   `verify --shards <N> --shard <i>` to write disjoint slices
   (`VERIFY.todo.<i>.json`), give one slice to each skeptic subagent, and collect
   their `verdicts.<i>.json` back (recipe in the playbook).

6. **Gate.**
   ```
   node scripts/ultrasearch.mjs verify --apply <verdicts.json | dir | a,b,c> --run <masterDir>
   node scripts/ultrasearch.mjs check  --semantic --run <masterDir>
   ```
   `--apply` takes one file, a directory, or a comma list, so sharded verdicts
   reassemble. Fails on dangling/unsourced (mechanical) AND on any
   refuted/unsupported claim (semantic); it also reports **contradictions** —
   claims whose cited sources disagree. Fix the claim — re-cite, drop it, or
   `fetch` a better source — and re-verify until it passes.

7. **Loop until dry.** Inspect the master dossier + report for residual gaps,
   contradictions, or new sub-questions. If any surface and you are under the
   round budget, fan out the new sub-questions (step 2), `merge` them into the
   SAME master, and re-verify only the new claims. Stop when nothing new emerges.

8. **Render & present.** `render --run <masterDir>` → `index.html` (verdict
   badges, a contradictions panel, the sub-question tree) **and** `index.md`
   (the consolidated markdown, verification table included). Present the SUMMARY,
   the master folder, the per-claim verdict summary, and any contradictions.

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
pins the general-web discovery layer (default `auto` runs a keyless cascade:
SearXNG → DuckDuckGo → DuckDuckGo Lite → Mojeek → Marginalia). At `summary` depth
it stops at the first engine that returns enough; at `standard`/`deep` it fuses
several engines for wider recall, and each engine fetches more result **pages** —
both scaled by depth and overridable with `--web-breadth <n>` / `--pages <n>`
(≤5). `--lang <code>` (+ optional `--region <cc>`) makes every web backend search
in that locale — translate your `--queries` to match; write the report in the
user's language. `--rounds 2` adds a gap-driven follow-up web search for question
terms the first pass under-covered; `--concurrency` tunes page-fetch parallelism.
PDFs (incl. arXiv papers) are read for full text, not just the abstract.

## References

- `references/research-playbook.md` — how to pick a mode, query, enrich, iterate.
- `references/deep-research-playbook.md` — the agentic deep tier: decompose →
  fan-out → merge → verify → loop-until-dry.
- `references/citation-format.md` — the citation grammar `check` enforces.
- `references/report-templates.md` — the per-mode report skeletons.
- `references/modes.md` — mode → backend profile + extras mapping.
- `references/backend-apis.md` — the keyless endpoints + rate limits.
- `references/web-discovery.md` — the layered keyless web search + WebSearch bridge.
- `references/html-rendering.md` — what `render` produces and how citations map.
