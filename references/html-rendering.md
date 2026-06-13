# HTML rendering

`render --run <dir>` turns the report tiers into a single, self-contained
`index.html` — embedded CSS, no external scripts or stylesheets, works offline,
easy to share or learn from.

## What it renders

- **Header** — the question, plus a meta line (mode · depth · source count · date).
- **TOC sidebar** — the tiers (Summary / Report / Full / Glossary) and each
  tier's `##` headings, as anchor links.
- **One section per tier** — `SUMMARY.md`, `REPORT.md`, `FULL.md`, and
  `glossary.md` if present, rendered from markdown.
- **Sources appendix** — built from `sources.json`: each source as
  `[S#] title` (linked to the original URL) with backend · domain · trust.

## Citations & hints in the HTML

- `[S#]` becomes a superscript anchor linking to that source in the appendix
  (`#src-S#`).
- `[M]` becomes a small "model hint" badge.
- A `> [model-hint] …` blockquote renders as a distinct amber callout labelled
  "model hint · unverified", so a reader instantly sees what is sourced vs. what
  is the model's own background knowledge.

## Markdown supported

Headings, paragraphs, **bold**/*italic*, `inline code`, fenced code blocks,
ordered/unordered lists, blockquotes, tables (`| a | b |` with a `|---|`
separator), horizontal rules, and links. It's a deliberately small CommonMark
subset implemented with zero dependencies and bundled into `scripts/
ultrasearch.mjs` — keep report markdown within these constructs so the HTML is
faithful.

## Determinism

The rendered body contains no timestamps (the date lives only in the header meta
line, sourced from `manifest.json`), so the same dossier renders byte-identically
every time — handy for fixtures and diffs.
