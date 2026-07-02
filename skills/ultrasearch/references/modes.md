# Modes — backend profile + extras

Each mode maps to a backend-priority profile and a set of extra outputs. At
`--depth deep` the mode's *deep-only* backends are added too. Override the whole
set with `--backends a,b,c`. List them live with `node scripts/ultrasearch.mjs
modes`.

| Mode | Backends (standard) | + deep-only | Extras |
|------|--------------------|-------------|--------|
| `topic` | wikipedia, searxng, duckduckgo | — | — |
| `bug` | stackexchange, github, duckduckgo, hackernews | searxng | — |
| `research` | arxiv, openalex, crossref, semanticscholar, europepmc | pubmed, duckduckgo, wikipedia | `bibtex` (refs.bib) |
| `learn` | wikipedia, duckduckgo, searxng | — | `glossary`, `exercises` |
| `startup` | duckduckgo, searxng, hackernews | wikipedia | — |

`stackexchange` fans out across Stack Overflow + Server Fault + Super User +
Ask Ubuntu + Unix & Linux. `europepmc` adds biomedical/life-sciences papers and
`pubmed` (deep) adds MeSH-indexed/clinical records — so research mode is no
longer physics/CS-only.

All five modes compose with the **deep research tier** (`plan` / `merge` /
`verify`): `plan` derives its sub-question facets from the mode's report
template, so the decomposition is mode-aware. See
`references/deep-research-playbook.md`.

## Recall behavior

- **Query variants** — every run plans a few query variants (the full question,
  a distinctive-keyword query, and an identifier query at `deep`) and fans the
  general/scholarly backends out across them, fusing the results — so keyword
  APIs aren't choked by stopwords. Count scales with `--depth`.
- **Content-aware ranking** — sources are re-ranked by how well their fetched
  text actually covers the question (plus fusion rank and trust) before the
  `--max-sources` cut, so a deeply-relevant page a backend ranked low survives.
- **Identity dedup** — the same work across arXiv/Crossref/OpenAlex/Semantic
  Scholar/Europe PMC collapses to one source by DOI/arXiv id.
- **`--since`** filters date-capable backends (Crossref, OpenAlex, GitHub,
  Stack Exchange, Hacker News); **`--web-engine`** pins or drops the general-web
  discovery layer — value list + cascade in `references/web-discovery.md`.

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
