# Standard playbook — gather → enrich → write → render → check

The loop that turns a question into a grounded, tiered report **without** the
deep tier. This is the route most asks take. For the exhaustive, adversarially
verified loop see `references/deep-research-playbook.md`.

## 1. Pick the mode

| The user wants… | Mode |
|-----------------|------|
| a neutral briefing on a subject | `topic` |
| to fix an error / understand a failure | `bug` |
| a survey of the academic literature | `research` |
| to learn the topic from scratch | `learn` |
| market/competitor/pricing research | `startup` |

Default to `topic` when unsure. Mode sets both the **backends** and the **report
template** (`references/modes.md`, `references/report-templates.md`). `modes`
prints the live mapping — trust it over any table in a doc.

## 2. Pick the depth

`summary` for a single-fact lookup · `standard` for a normal report · `deep`
when the answer will be acted on. The budget each buys is in
`references/modes.md`. Going deeper is not free: `standard` fuses two engines
and keeps 25 sources, `deep` fuses five and keeps 60.

## 3. Phrase the query

The keyless backends search literally. Lead with the distinctive terms:
- the natural phrasing ("token bucket rate limiting"),
- the exact error text / status code / flag for `bug` mode ("429 Too Many Requests"),
- author or method names for `research` mode.

`gather` once with the best phrasing. To probe a phrasing cheaply first,
`search --backend <kind> --q "<variant>"` prints ranked results and writes
nothing. When you already know the distinctive phrasings, pass them all at once
with `--queries "natural phrasing|exact error text|author method"` — they
override the built-in planner and fan out across the multi-query backends in a
single run.

**Search in the audience's language** (`--lang`/`--region`, translated
phrasings) — SKILL.md's locale invariant. Know the authoritative hosts? Add
`--seed-domains docs.aws.amazon.com,developer.mozilla.org` (≤3) for one targeted
`site:` search each.

## 4. Read, then find the gaps

Open `DOSSIER.md`. Three banners tell you what retrieval could not do:

- **⚠ Thin dossier** — fewer on-topic sources than the depth's recall floor
  (summary 3 · standard 6 · deep 12). Treat enrichment as mandatory.
- **🔍 Under-covered** — named question terms that fewer than two of the top
  sources mention. This is your enrichment worklist: it tells you *which* angle
  is missing, not just that something is.
- **⚠ snippet only** (per source) — the page fetch failed, so only the search
  snippet is on file. Don't lean on it; re-`fetch` it or find a primary source.

More generally the dossier is thin when no source addresses the specific
question, or when one backend dominated and a needed angle is missing (e.g.
`bug` has Stack Overflow answers but no GitHub issue confirming the fix).

## 5. Top up with a second WebSearch round

Your first sweep aimed at the question as asked; the dossier now names exactly
where it fell short (`🔍 Under-covered`, `⚠ Thin`, a missing angle). Run
**another WebSearch round** at those gaps — the authoritative primary sources,
the specific thing the user asked about — then fold the whole round in at once:

```
node <skill-dir>/scripts/ultrasearch.mjs ingest --run <dir> --web-results <round2.json>
```

One process, one `S#` per page, one outcome line per URL — added, already there,
or refused with the reason. Use `fetch --url "<url>" --out <dir>` only for a
single page; calling it in a loop is what `ingest` exists to replace. Aim for
solid coverage of every section of the template.

## 6. Triage before writing

Retrieval is recall-oriented, so some sources merely share keywords. A source
bears on the question only if its text **describes the same thing the question is
about** — not just shares a word. Ignore the rest; never cite a source just
because it exists.

## 7. Fan out only when it pays

A fan-out costs one subagent per sub-question plus a merge. It pays when the ask
has **two or more independent facets** — angles you would search with genuinely
different queries ("how it works" vs "who runs it in production"). One facet
fans out to one gatherer, which is strictly worse than gathering yourself.

When it does pay:
```
node <skill-dir>/scripts/ultrasearch.mjs plan --q "<question>" --mode <m> --max-subquestions 3 --run-root <RUN>
node <skill-dir>/scripts/ultrasearch.mjs orchestrate --run <RUN> --phase gather
node <skill-dir>/scripts/ultrasearch.mjs merge --runs "<RUN>/q1,<RUN>/q2,<RUN>/q3" --master <RUN> --q "<question>" --mode <m>
```
After the merge, cite **MASTER `[S#]` ids only** — sub-run ids all restart at S1.

## 8. Write the two tiers

Write `SUMMARY.md` and `REPORT.md` against the mode template. Cite every claim
`[S#]`; flag your own knowledge `[M]` / `> [model-hint]`. `REPORT.md` should use
every relevant source and end with "Open questions / contradictions".

**Write in the user's language** (quote a foreign-language source verbatim where
the exact wording matters, then gloss it) — search locale ≠ output language.

## 9. Render, check, present

```
node <skill-dir>/scripts/ultrasearch.mjs render --run <dir>   # → index.html AND index.md
node <skill-dir>/scripts/ultrasearch.mjs check  --run <dir>
```

The mechanical `check` **is** this route's exit gate; fix citations or add
sources until it passes. Two knobs tighten it without invoking the deep tier:
`--strict-numerals` (an unattributed figure fails instead of warning) and
`--min-sources <n>` (a too-thin dossier fails).

**`--semantic` is not part of this loop.** It fails closed without an
adjudicated `VERIFY.json`, so on a run you never verified it can only fail —
see `references/citation-format.md`.

Then present the SUMMARY, the folder + `index.html`/`index.md` paths, the source
count, and the gaps/contradictions you found.

## 10. When to escalate to the deep tier

Escalate — don't patch — when any of these is true:

- the user asked for "deep research", or to exhaustively research/verify,
- the report will be acted on: it ships to users, costs money, or informs a
  decision that is expensive to reverse,
- this route came back contradictory, or the under-covered list stayed long
  after enrichment.

The deep tier is an all-or-nothing upgrade: decompose → fan out → merge →
adversarially verify → gate. Half of it is not a stricter standard run.
