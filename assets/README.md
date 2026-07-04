# assets/example-dossier

A complete sample `ultrasearch` run (topic mode, offline `fixture` backend) so
you can see the output shape without running anything:

- `manifest.json` · `sources.json` · `sources/S#.md` — the evidence dossier the
  engine writes.
- `DOSSIER.md` — the model-facing brief (template + grounding rules + sources).
- `SUMMARY.md` / `REPORT.md` — the two model-written tiers, every
  claim cited `[S#]`, with one `> [model-hint]` callout demonstrating how
  unverified background knowledge is flagged.
- `index.html` — the self-contained rendered report (open it in a browser).

It passes `node scripts/ultrasearch.mjs check --run assets/example-dossier`.
