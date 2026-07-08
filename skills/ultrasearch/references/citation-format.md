# Citation format

Every factual claim in `REPORT.md` must be followed by a citation
that resolves to a source in the run's `sources.json`. `ultrasearch check` parses
these and fails the report if any citation is dangling, if a claim is unsourced
and unflagged, or if there are no citations at all. This is the mechanical guard
that keeps the report grounded in retrieved sources rather than the model's
memory.

## Source citations (required)

Cite the bracketed id shown for each source in `DOSSIER.md`:

```
Rate limiting caps how many requests a client may make in a window [S1].
A token bucket allows bursts up to the bucket size [S2]. Exceeding the limit
returns HTTP 429 [S3][S7].
```

- One or more ids per claim: `[S1]`, `[S1][S4]`.
- Ids are stable within a run (`S1`, `S2`, …) in fused-rank order.

## Model hints (your own knowledge — must be flagged)

You MAY add background knowledge no fetched source backs, but you must flag it as
unverified, either inline or as a callout:

```
Most production gateways default to token buckets. [M]
```
```
> [model-hint] Sliding-window counters are common in API gateways, though no
> source in this dossier confirms that.
```

`check` tolerates flagged hints (they never fail the run) but counts them, and
the HTML renders them as a distinct "model hint · unverified" callout so a reader
can tell them apart from sourced claims.

## Rules `check` enforces

- A report with **no** source citations fails.
- Any `[S#]` that does not resolve to `sources.json` fails (a fabricated `[S99]`).
- An **unmarked, unsourced** prose claim in REPORT fails — add a `[S#]` or
  flag it `[M]` / `> [model-hint]`.
- Markdown links `[text](url)` are **not** citations and are ignored.
- `SUMMARY.md` and `glossary.md` are checked leniently (warn, not fail) on
  per-claim coverage — a digest needn't repeat a source on every line — but a
  dangling `[S#]` anywhere still fails.
- Uncited sources are fine (informational warning only).

## What `check` verifies (and its limits)

`check` is a mechanical guard, not a proof. It verifies coverage at
**paragraph / list-item / table-row granularity**: a unit passes if it contains
at least one `[S#]` (or a model-hint flag). Known limits you should not lean on:

- A single `[S#]` grounds its whole paragraph, so a fabrication appended to a
  genuinely-cited sentence in the same paragraph can ride along. Cite each
  distinct claim, and split unrelated claims into separate sentences/paragraphs.
  (The deep tier's semantic verification — below — closes this gap by judging
  whether the cited source actually supports the claim.)
- Citations inside fenced/inline code and **HTML comments** are ignored (a
  comment can't ground a claim). Markdown links are not citations.
- Section **headings** are treated as structure, not claims — don't smuggle a
  factual assertion into a heading.
- A trailing `## Sources` / `## References` section is the rendered appendix,
  not prose: its lines are never claims and its `[S#]` listing does not count
  as citation coverage (a dangling `[S#]` there still fails). Cite in the body
  — a report whose only `[S#]` sit in the appendix fails with "No source
  citations found".

## Semantic verification (the deep tier)

Mechanical `check` proves a `[S#]` is *present* next to a claim; it does not
prove the cited source *supports* it. The deep tier closes that gap:

- `verify --run <dir>` pairs every `(claim, [S#])` with a digest of the cited
  extract (`VERIFY.todo.json` / `VERIFY.md`), reusing the same claim parser as
  `check`.
- You adjudicate each pair: `supported` · `partial` · `unsupported` · `refuted`
  (+ a short note), and save the filled file.
- `verify --apply <verdicts.json>` then `check --semantic` **fail** the report
  when a claim's source refutes it, or when every cited source is unsupported —
  on top of the mechanical gate, never relaxing it.

A source's worst verdict tints its citations in the HTML, and a Verification
section lists every claim's verdict. See `references/deep-research-playbook.md`.

## Good practice

- Prefer citing the highest-trust source for a claim (see `trust` in
  `sources.json`); corroborate contested claims with two sources.
- If the sources don't support a claim, don't make it — `fetch` more, or state
  the unknown explicitly.
