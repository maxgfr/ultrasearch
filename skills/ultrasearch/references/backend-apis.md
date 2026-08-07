# Backend APIs — keyless endpoints & rate limits

Every backend is keyless and free. All requests go through one HTTP layer with
a timeout, a UA string, and a body cap; a backend never throws — failures become
honest notes in the dossier.

| Backend | Endpoint | Notes / limits |
|---------|----------|----------------|
| `searxng` | `GET {base}/search?q=…&format=json` | base = `--searxng` / `ULTRASEARCH_SEARXNG` / `http://localhost:8888`. **Public instances usually disable `format=json`** (returns 403/HTML) — run your own (`docker compose --profile search up -d`; a bare `docker compose up` starts nothing). Skips silently when unreachable. |
| `firecrawl` | `POST {base}/v2/search` (falls back to `/v1` on 404) | Self-hosted Firecrawl, keyless (`USE_DB_AUTHENTICATION=false`); base = `--firecrawl` / `ULTRASEARCH_FIRECRAWL` / `http://localhost:3002`, `off` disables. Its own cascade is Fire-Engine → SearXNG → DuckDuckGo. **Explicit only** — never in the `auto` cascade. Gated by a memoised 2s probe of `GET /`. |
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
| `pubmed` | `esearch.fcgi` → idlist, then `esummary.fcgi` (db=pubmed, `tool=ultrasearch`, no email/PII) | MeSH-indexed/clinical (research deep). esummary is metadata-only → the gatherer hydrates the DOI/PubMed landing page for the abstract, falling back to `efetch.fcgi` when that page walls (see below). |
| `dblp` | `GET https://dblp.org/search/publ/api?q=…&format=json` | Computer-science bibliography (research deep). Metadata-only → the gatherer hydrates the `ee`/DOI landing page; DOI/author metadata dedupes it against Crossref/OpenAlex and feeds `refs.bib`. |
| `standards` | `GET https://datatracker.ietf.org/api/v1/doc/document/?format=json&name=rfc<n>` (or `&title__icontains=…`) + `GET https://developer.mozilla.org/api/v1/search?q=…&locale=en-US` | Defining specs for standards-backed topics (topic/bug standard, learn deep). An explicit "RFC 6585" resolves directly; else a title search kept to real RFC numbers with a word-boundary relevance re-check (drops the "RFC 2429 shares digits" false friend). RFC abstract is the text; the source URL is `rfc-editor.org/rfc/rfc<n>` (clean full text on hydration). MDN hits are discovery (url + summary). |

## Content extraction

- HTML pages are narrowed to their **main content region** (a dependency-free
  readability pass — `<main>`/`<article>`/content containers) before the prose
  strip, so nav/sidebar/footer boilerplate doesn't dilute the text or the
  relevance score. It falls back to the full document when no main region is
  confidently found, so it never extracts *less* than a blunt strip.
- **PDFs** (`.pdf` URL or `application/pdf`) go through an **extractor ladder**,
  stopping at the first rung whose output passes a quality gate:
  1. **pdf-inspector** — `npx -y --prefer-offline @firecrawl/pdf-inspector -`,
     the PDF bytes on stdin. Real Markdown with reading order and tables, and
     always the latest version. Costs one ~6 MB npx download the first time it
     is ever used, in a child process (so it can never take a run down).
     `ULTRASEARCH_NO_NPX=1` skips this rung.
  2. **anydoc** — `npx -y --prefer-offline @firecrawl/anydoc - --format pdf`.
     The same conversion by another route: anydoc embeds pdf-inspector for text
     PDFs, and on a real paper the two outputs differ by a single trailing
     newline. It is here purely for **platform coverage** — npm publishes an
     anydoc binary for `darwin-x64` and pdf-inspector does not, so on an Intel
     Mac this is what keeps PDFs readable without Docker or poppler. It only
     ever runs after rung 1 has failed, so it costs nothing elsewhere.
     `ULTRASEARCH_NO_NPX=1` skips this rung too.
  3. **Firecrawl** — the already-running container, which covers hosts with no
     npm at all and any platform neither binary is built for (Docker runs the
     linux-x64 image there anyway).
  4. **pdftotext** — poppler, if installed. Fast, no network.
  5. the **built-in** dependency-free reader (`zlib`-inflated content streams →
     text operators). Frequently wrong on CID fonts and ligatures, so it is a
     last resort, kept only for a machine with no tools at all.

  The gate (`assessPdfText`) rejects output laced with C0/C1 control bytes or
  U+FFFD, whatever its LENGTH — the built-in reader can emit 16 MB of
  image-stream garbage for a 12 MB paper, which every length-limited check waves
  through. When every rung fails, the source is REFUSED with a reason rather
  than cited: a scanned PDF says so instead of quietly contributing nothing.
  `ULTRASEARCH_PDF_ENGINE=<rung>` forces one rung; `ultrasearch doctor` shows
  which are available.

  arXiv PDFs are cited as `/abs/<id>` but READ as the PDF (`preferText` in
  providers.ts): the abstract page always fetches successfully, so treating the
  PDF as a mere fallback meant papers were only ever grounded on their abstract.
- **Office documents** — `.docx`/`.doc`/`.odt`/`.rtf`, `.pptx`/`.ppt`/`.odp`,
  `.xlsx`/`.xls`/`.ods`, `.epub`, `.csv`, recognised by extension or by
  content-type — go through their own two-rung **document ladder**:
  1. **anydoc** — `npx -y --prefer-offline @firecrawl/anydoc -`, the bytes on
     stdin, converting to GitHub-Flavored Markdown. The format is read from the
     BYTES (ZIP package mimetype, OLE stream names, the RTF open group), so a
     mislabelled file still converts; `--format` is passed only for CSV, which
     has no signature to detect from stdin.
  2. **Firecrawl** — the already-running container, for hosts without npm.

  Same gate as the PDF ladder, and the same refusal: when no rung can read the
  document the source is REFUSED with a reason. That refusal is the point. These
  formats are ZIP or OLE containers, so the older behaviour — falling through to
  "not HTML, use the response body as text" — did not degrade the evidence, it
  fabricated it: a `.docx` entered the dossier as hundreds of kilobytes of
  U+FFFD, citable, with no note saying anything was wrong. The one exception is
  `.csv`, which is already readable as plain text and so falls back to its raw
  body instead of being refused.

  anydoc needs **Node 20+**, one version above this package's own floor, so an
  unavailable converter is a normal outcome on a Node 18 host rather than a
  misconfiguration. `ULTRASEARCH_DOC_ENGINE=<rung|none>` forces one rung or
  disables the ladder; `ultrasearch doctor` shows what is available.

  PDFs never take this path — they have their own ladder, with rungs this one
  does not have.
- When a self-hosted **Firecrawl** answers (`docker compose --profile search
  --profile extract up -d`), HTML pages are extracted through it FIRST — a real
  headless browser returning main-content markdown via `POST {base}/v2/scrape`
  (`formats:["markdown"], onlyMainContent, blockAds, removeBase64Images`, plus a
  24h `maxAge` so Firecrawl can serve its own cached copy). One page per call;
  the async `/batch/scrape` job API is deliberately unused. **Any** failure —
  disabled, unreachable, non-2xx, empty markdown — falls back to the built-in
  reader below. PDFs never take this HTML path — they reach Firecrawl only as
  rung 2 of the ladder above, after the bytes are already in hand. Firecrawl
  markdown is richer than
  the stripped text, so it hits the `--depth` extract caps sooner.
- A short extraction dominated by **consent / anti-bot / "enable JavaScript"**
  boilerplate is rejected (it can't masquerade as full text): the source keeps
  only its search snippet and is marked `⚠ snippet only`. When Firecrawl is up,
  the page is **re-extracted through it first** — a browser gets past most walls
  — and only demoted to snippet-only if that also comes back as boilerplate.
- A **dead link** (404/410/451/403) is retried against the **Wayback Machine**'s
  closest snapshot before it's dropped; the recovered text is used, the original
  URL is kept, and a note records the snapshot (disable with
  `ULTRASEARCH_NO_WAYBACK`; capped per run).

## Citable URLs — fetch anywhere, cite a page

A source's URL is a promise to the reader: click it, get the document. A machine
endpoint breaks that promise. But endpoints are often exactly where the text is
— a page rate-limits or walls while a keyless API next door keeps serving the
same record (PubMed answers `pubmed.ncbi.nlm.nih.gov/<pmid>/` with a reCAPTCHA
interstitial **under HTTP 200**, while E-utilities hands back the abstract).

So the two roles are kept apart, by rules that are **provider-agnostic**:

1. **Is this URL citable?** Shape alone decides: a known API host, an `/api/`,
   `.fcgi`, `webservices/` path, or a `format=json` / `retmode=text`-style
   parameter. No allow-list of services to maintain.
2. **If it isn't, what document is this?** The payload is asked to name itself,
   in descending order of authority: the `<link rel="canonical">` / `og:url` the
   page declares → a **DOI** → an **arXiv id** → a **PMID**. Whatever answers
   first becomes the recorded URL; the endpoint is kept in `meta.textVia`.
3. **If nothing answers**, the engine refuses rather than cite an endpoint —
   and hands the job back to you, because reconstructing a page from a title is
   a search, not a regex. Two ways in: `fetch --url "<endpoint>" --cite-url
   "<page>"` at ingest time, or `relink --id S# --url "<page>"` afterwards. Both
   keep the endpoint in `meta.textVia`.

Two things need the URL's shape *before* a request is spent, and those are the
only per-provider entries — a short, optional table (an unlisted URL just falls
through to the generic path):

| Shape | Effect |
|---|---|
| `…/efetch.fcgi?db=pubmed&id=<pmid>` (one id) | recorded as `https://pubmed.ncbi.nlm.nih.gov/<pmid>/` |
| `pubmed.ncbi.nlm.nih.gov/<pmid>/` | text falls back to `efetch.fcgi?…&rettype=abstract&retmode=text` when the page walls |
| `…?id=<a,b,c>` (several ids) | **refused** — a source is ONE document; pass the ids one at a time |
| `…/esearch.fcgi?term=…` | **refused** — a query points at a result list, not a document |
| `pmc.ncbi.nlm.nih.gov/articles/PMC<n>/` ↔ `…?db=pmc&id=PMC<n>` | recorded as the PMC page |
| `arxiv.org/pdf/<id>` | recorded as `arxiv.org/abs/<id>`, text still read from the PDF |

The same three rules run again as a repair pass over a finished dossier:
`relink --run <dir>` re-reads each stored extract, rewrites every source whose
own text proves where it lives, and hands you the rest as a worklist. Each
remaining entry carries `evidence` — the record's title and the head of its
text — because that is what a search needs; `--id S# --url "<page>"` folds your
answer back in. `check` warns about what is left, so a dossier gathered before
any of this can still be brought up to standard.

## Rate-limit etiquette

- `--per-source` caps results per backend; `--depth` scales it.
- Rate-limited backends (GitHub, StackExchange, Semantic Scholar, PubMed) are
  queried with a **single** query variant per run (no variant fan-out).
- The polite scholarly APIs that DO fan out across variants (arXiv, Crossref,
  OpenAlex, Europe PMC, dblp) run their per-variant calls **sequentially** with a
  small gap (`ULTRASEARCH_POLITE_DELAY_MS`, default 400ms) rather than all at
  once, so a multi-query run never opens N connections to the same host.
- Every request retries **once** on a transient status (429/503) — honoring
  `Retry-After` (clamped to 5s) — so one throttled call doesn't zero a backend.
  Tunable via `ULTRASEARCH_MAX_ATTEMPTS` / `ULTRASEARCH_RETRY_MS` — but these
  delays exist to keep free services willing to serve us. Zero them in CI, never
  on a live run. Full env-var table: `references/operations.md`.
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

Each source gets a 0–1 `trust` from the ROUTE it arrived by, and nothing else:
a scholarly API vouches for a bibliographic record, a general-web engine vouches
for nothing (0.5, neutral). There is deliberately **no hostname table** — one
used to exist and it scored the WHATWG HTML Standard the same as a content farm,
because nobody had added whatwg.org to it.

So `trust` does not tell you whether a page is any good. That judgment is yours,
made from the extract, helped by the three measured facts each source carries
(external sources cited · engines that surfaced it · whether it declares a
persistent identity). Prefer the primary source when a claim is contested, and
say so in the report when only a weak source carries one.
