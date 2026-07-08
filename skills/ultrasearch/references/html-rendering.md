# HTML rendering

`render --run <dir>` turns the report tiers into a single, self-contained
`index.html` — embedded CSS, no external scripts or stylesheets, works offline,
easy to share or learn from. By default it **also** writes a consolidated
`index.md` next to it (see "Markdown report" below). `--no-html` / `--no-md` skip
either output.

## What it renders

- **Header** — the question, plus a meta line (mode · depth · source count · date).
- **TOC sidebar** — the tiers (Summary / Report / Glossary) and each
  tier's `##` headings, as anchor links.
- **One section per tier** — `SUMMARY.md`, `REPORT.md`, and
  `glossary.md` if present, rendered from markdown.
- **Sources appendix** — built from `sources.json`: each source as
  `[S#] title` (linked to the original URL) with backend · domain · trust. A
  source no report tier cites is dimmed and tagged `uncited` (in `index.md`,
  `· uncited`), so a reader can tell research the report actually used from
  retrieved-but-unused noise. Nothing is dimmed before any tier cites a source.
- **Verification section** (deep tier, when `VERIFY.json` is present) — a table
  of every claim's verdict (supported · partial · refuted · unsupported) with the
  cited source and note, plus a headline grounded/failed status.
- **Sub-question tree** (merge dossiers, when `manifest.subQuestions` is present)
  — each sub-question and the sources its fan-out surfaced (from provenance).
- **Contradictions callout** — when a tier has an "Open questions / contradictions"
  heading, a callout near the top links to it.

## Citations & hints in the HTML

- `[S#]` becomes a superscript anchor linking to that source in the appendix
  (`#src-S#`).
- `[M]` becomes a small "model hint" badge.
- A `> [model-hint] …` blockquote renders as a distinct amber callout labelled
  "model hint · unverified", so a reader instantly sees what is sourced vs. what
  is the model's own background knowledge.
- In deep mode, each `[S#]` is tinted by its source's worst semantic verdict
  (green supported · amber partial · grey unsupported · red refuted), so a reader
  spots a contested citation at a glance.

## Markdown supported

Headings, paragraphs, **bold**/*italic*, `inline code`, fenced code blocks,
ordered/unordered lists, blockquotes, tables (`| a | b |` with a `|---|`
separator), horizontal rules, and links. It's a deliberately small CommonMark
subset implemented with zero dependencies and bundled into `scripts/
ultrasearch.mjs` — keep report markdown within these constructs so the HTML is
faithful.

## Markdown report (`index.md`)

Alongside `index.html`, `render` writes `index.md` by default — the markdown
counterpart of the HTML, so every run yields a portable, plain-text deliverable.
(It's `index.md`, not `report.md`: on case-insensitive filesystems — macOS APFS,
Windows — a file named `report.md` would be the same file as the `REPORT.md` tier
and clobber it.) Contents:

- a title (the question) + a meta line (mode · depth · sources · lang/region · date),
- each authored tier (Summary / Report / Glossary) in order, separated by rules,
- the verification summary + per-claim verdict table (deep tier, when present),
- a Sources appendix (`[S#] title` linked to the URL, with backend · domain · trust).

It is assembled deterministically from the same dossier files, so it diffs cleanly.
Skip it with `--no-md`; skip the HTML with `--no-html`.

## Determinism

The rendered body contains no timestamps (the date lives only in the header meta
line, sourced from `manifest.json`), so the same dossier renders byte-identically
every time — handy for fixtures and diffs.
