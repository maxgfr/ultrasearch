# Citation format

Every factual claim in `REPORT.md` and `FULL.md` must be followed by a citation
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
- An **unmarked, unsourced** prose claim in REPORT/FULL fails — add a `[S#]` or
  flag it `[M]` / `> [model-hint]`.
- Markdown links `[text](url)` are **not** citations and are ignored.
- `SUMMARY.md` and `glossary.md` are checked leniently (warn, not fail) on
  per-claim coverage — a digest needn't repeat a source on every line — but a
  dangling `[S#]` anywhere still fails.
- Uncited sources are fine (informational warning only).

## Good practice

- Prefer citing the highest-trust source for a claim (see `trust` in
  `sources.json`); corroborate contested claims with two sources.
- If the sources don't support a claim, don't make it — `fetch` more, or state
  the unknown explicitly.
