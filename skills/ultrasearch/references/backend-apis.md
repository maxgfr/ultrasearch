# Backend APIs — keyless endpoints & rate limits

Every backend is keyless and free. All requests go through one HTTP layer with
a timeout, a UA string, and a body cap; a backend never throws — failures become
honest notes in the dossier.

| Backend | Endpoint | Notes / limits |
|---------|----------|----------------|
| `searxng` | `GET {base}/search?q=…&format=json` | base = `--searxng` / `ULTRASEARCH_SEARXNG` / `http://localhost:8888`. **Public instances usually disable `format=json`** (returns 403/HTML) — run your own (`docker-compose up`). Skips silently when unreachable. |
| `duckduckgo` | `GET https://html.duckduckgo.com/html/?q=…` | HTML scrape; decodes the real URL from the `uddg` redirector param. Fragile if DDG changes markup and can rate-limit — the WebSearch bridge is the real workhorse. |
| `ddglite` | `GET https://lite.duckduckgo.com/lite/?q=…` | HTML scrape of DDG's flat "lite" results table; simpler/sturdier markup than the main endpoint. First cascade fallback for `duckduckgo`. |
| `mojeek` | `GET https://www.mojeek.com/search?q=…` | HTML scrape of an independent crawler/index (not a Bing/Google reseller). Direct result URLs (no redirector). Widens recall; cascade fallback. |
| `marginalia` | `GET https://api.marginalia-search.com/public/search/{q}` | Free public JSON API, no key. Indexes the non-commercial, text-first long-tail web. Broad-recall final cascade fallback; best-effort. |
| `wikipedia` | `…/w/rest.php/v1/search/page` + `…/api/rest_v1/page/summary/{title}` | Language-aware via `--lang`. Returns the summary extract as text. |
| `stackexchange` | `GET https://api.stackexchange.com/2.3/search/advanced?site=<site>&filter=withbody` | Fans out across `stackoverflow, serverfault, superuser, askubuntu, unix.stackexchange` (one small page each). Reads `quota_remaining`/`backoff` into a note. Body HTML → text. |
| `hackernews` | `GET https://hn.algolia.com/api/v1/search?tags=story` | Generous. Ask-HN posts have no `url` → falls back to the discussion link. |
| `github` | `GET https://api.github.com/search/issues?q=…` | Unauthenticated search is **~10 req/min** — one page; may 403 when throttled (recorded as a note). |
| `arxiv` | `GET http://export.arxiv.org/api/query?search_query=all:…` | Atom XML; parsed for title/summary/id/authors/year. The source URL points at the HTML full text (`arxiv.org/html/<id>`) so the gatherer hydrates the whole paper, not just the abstract; the abstract is the snippet/fallback when no HTML rendering exists. |
| `crossref` | `GET https://api.crossref.org/works?query=…` | Polite pool. Abstracts (when present) are JATS XML → stripped. |
| `openalex` | `GET https://api.openalex.org/works?search=…` | Abstract is an inverted index → reconstructed to text. |
| `semanticscholar` | `GET https://api.semanticscholar.org/graph/v1/paper/search` | Unauthenticated; can rate-limit. Carries DOI + arXiv id in `externalIds`. |
| `europepmc` | `GET https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core` | Biomedical/life-sciences. `resultType=core` returns the abstract inline (content backend). Carries DOI + journal + year. |
| `pubmed` | `esearch.fcgi` → idlist, then `esummary.fcgi` (db=pubmed, `tool=ultrasearch`, no email/PII) | MeSH-indexed/clinical (research deep). esummary is metadata-only → the gatherer hydrates the DOI/PubMed landing page for the abstract. |

## Content extraction

- HTML pages are narrowed to their **main content region** (a dependency-free
  readability pass — `<main>`/`<article>`/content containers) before the prose
  strip, so nav/sidebar/footer boilerplate doesn't dilute the text or the
  relevance score. It falls back to the full document when no main region is
  confidently found, so it never extracts *less* than a blunt strip.
- **PDFs** (`.pdf` URL or `application/pdf`) are run through a best-effort,
  dependency-free text-layer extractor (`zlib`-inflated content streams → text
  operators). Scanned/image-only or encrypted PDFs may yield little — that's
  reported as a note. This lets `research` papers (and any PDF you `fetch`) be
  read beyond their abstract.

## Rate-limit etiquette

- `--per-source` caps results per backend; `--depth` scales it.
- Rate-limited backends (GitHub, StackExchange, Semantic Scholar, PubMed) are
  queried with a **single** query variant per run (no variant fan-out).
- Every request retries **once** on a transient status (429/503) — honoring
  `Retry-After` (clamped to 5s) — so one throttled call doesn't zero a backend.
  Tunable via `ULTRASEARCH_MAX_ATTEMPTS` / `ULTRASEARCH_RETRY_MS`.
- The hydrate step (fetching discovered pages) runs with **bounded concurrency**
  (default 6, set with `--concurrency`) so a run stays polite rather than firing
  dozens of fetches at once.
- Requests send a realistic desktop-browser **User-Agent** (many keyless web
  endpoints serve 403/empty to bot UAs); override with `ULTRASEARCH_UA`. The
  polite scholarly APIs (arXiv, Crossref) instead send a contact UA so they can
  attribute the traffic.
- When a backend is throttled or down, it returns no items + an honest note
  (429s are reported as rate-limited, not "unreachable") — the run continues on
  the others, and you should enrich via your own WebSearch.

## Trust scoring

Each source gets a 0–1 `trust` from its domain class (`.gov`/`.edu`/Wikipedia/
official docs high; SEO/aggregator low) and its backend authority (scholarly
APIs high). Prefer higher-trust sources when a claim is contested.
