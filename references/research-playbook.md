# Research playbook — gather → enrich → write → render → check

The loop that turns a question into a grounded, tiered report.

## 1. Pick the mode

| The user wants… | Mode |
|-----------------|------|
| a neutral briefing on a subject | `topic` |
| to fix an error / understand a failure | `bug` |
| a survey of the academic literature | `research` |
| to learn the topic from scratch | `learn` |
| market/competitor/pricing research | `startup` |

Default to `topic` when unsure. Mode sets both the **backends** and the **report
template** (`references/modes.md`, `references/report-templates.md`).

## 2. Phrase the query

The keyless backends search literally. Lead with the distinctive terms:
- the natural phrasing ("token bucket rate limiting"),
- the exact error text / status code / flag for `bug` mode ("429 Too Many Requests"),
- author or method names for `research` mode.

`gather` once with the best phrasing; use `search --backend <kind> --q "<variant>"`
to probe other phrasings cheaply (it writes nothing). When you already know the
distinctive phrasings, pass them all at once with
`--queries "natural phrasing|exact error text|author method"` — they override the
built-in planner and fan out across the multi-query backends in a single run.

## 3. Read, then find the gaps

Open `DOSSIER.md`. A **⚠ Thin dossier** banner at the top means too few on-topic
sources were kept (below the depth's recall floor) — treat enrichment (step 4) as
mandatory. A source tagged **⚠ snippet only** had a failed page fetch, so only its
search snippet is on file: don't lean on it, re-`fetch` it or find a primary
source. More generally, the dossier is **thin** when:
- fewer than ~3 on-topic sources, or
- no source actually addresses the specific sub-question, or
- one backend dominated and a needed angle is missing (e.g. `bug` has SO answers
  but no GitHub issue confirming the fix).

For deep runs, `--rounds 2` automatically issues one extra web search for any
question terms the first pass under-covered — a cheap recall top-up before you
reach for your own WebSearch.

## 4. Enrich with your own WebSearch (the bridge)

The keyless backends are best-effort; SearXNG may be down and DuckDuckGo scraping
is fragile. **Use your own WebSearch tool** for:
- authoritative primary sources (official docs, standards, the vendor's blog),
- the specific thing the user asked about,
- anything the dossier is thin on.

Ingest each good URL so you can cite it:
```
node scripts/ultrasearch.mjs fetch --url "<url>" --out <dir>   # prints the new S#
```
Re-run for each URL. Aim for solid coverage of every section of the template —
more sources for `--depth deep`.

## 5. Triage before writing

Retrieval is recall-oriented, so some sources merely share keywords. A source
bears on the question only if its text **describes the same thing the question is
about** — not just shares a word. Ignore the rest; never cite a source just
because it exists.

## 6. Write the three tiers

Write `SUMMARY.md`, `REPORT.md`, `FULL.md` against the mode template. Cite every
claim `[S#]`; flag your own knowledge `[M]` / `> [model-hint]`. `FULL.md` should
use every relevant source and end with "Open questions / contradictions".

## 7. Render, check, present

`render` → `index.html`; `check` must pass (fix citations / add sources until it
does). Then present the SUMMARY, the folder + HTML path, the source count, and
the gaps/contradictions you found.
