# Modes — backend profile + extras

Each mode maps to a backend-priority profile and a set of extra outputs. At
`--depth deep` the mode's *deep-only* backends are added too. Override the whole
set with `--backends a,b,c`. List them live with `node scripts/ultrasearch.mjs
modes`.

| Mode | Backends (standard) | + deep-only | Extras |
|------|--------------------|-------------|--------|
| `topic` | wikipedia, searxng, duckduckgo | — | — |
| `bug` | stackexchange, github, duckduckgo, hackernews | searxng | — |
| `research` | arxiv, openalex, crossref, semanticscholar | duckduckgo, wikipedia | `bibtex` (refs.bib) |
| `learn` | wikipedia, duckduckgo, searxng | — | `glossary`, `exercises` |
| `startup` | duckduckgo, searxng, hackernews | wikipedia | — |

## Extras

- **bibtex** — the engine writes `refs.bib` from the scholarly sources (those
  carrying DOI / arXiv id / authors / year). Reference it from the report's
  `## References` section.
- **glossary** — you write `glossary.md` (`**term** — definition [S#]`, one per
  line); it renders as its own tab/section in the HTML.
- **exercises** — include `## Exercises` and `## Solutions` sections in the
  learn report.

## Backends

`searxng` and `duckduckgo` are *discovery* backends — they return candidate URLs
that the gatherer then fetches and cleans. The rest are *content* backends — they
return text directly (a Wikipedia summary, a Stack Overflow answer, an abstract).
`generic` fetches explicit `--url`s; `fixture` is the offline CI backend;
`claude` is the provenance label stamped on sources you add via `fetch`.

See `references/backend-apis.md` for the endpoints and rate limits.
