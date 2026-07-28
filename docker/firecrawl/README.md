# Self-hosted Firecrawl (profile `extract`)

Firecrawl fetches a page with a **real headless browser** and returns
main-content markdown. ultrasearch uses it as a content-cleaning layer in front
of its built-in regex HTML stripper: it beats the stripper on nav/cookie/footer
chrome, and it is the only way a JS-rendered page yields any text at all. It is
also what rescues the pages the junk detector currently throws away (consent
walls, "enable JavaScript" shells, anti-bot interstitials) — those contribute
nothing today.

**Keyless.** `USE_DB_AUTHENTICATION=false` (see `firecrawl.env`) turns the API's
auth off entirely, so no key is sent or needed. `/search` is keyless too — it
cascades Fire-Engine → SearXNG (the `search` profile's container, via
`SEARXNG_ENDPOINT`) → DuckDuckGo.

**Cost.** Five containers, ~3 GB of images, ~4 GB of RAM under load. That is why
it lives in its own profile and is *not* in `all`.

## Up and down

```bash
docker compose --profile search --profile extract up -d --wait   # ~1-2 min first run
docker compose --profile extract down                            # stop it
docker compose --profile extract down -v                         # …and drop the pg volume
```

`--wait` blocks until every healthcheck goes green.

## Smoke test

```bash
curl -s http://localhost:3002/                       # {"message":"Firecrawl API",...}

curl -s -X POST http://localhost:3002/v2/scrape \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown"],"onlyMainContent":true}' \
  | head -c 400

curl -s -X POST http://localhost:3002/v2/search \
  -H 'content-type: application/json' \
  -d '{"query":"rate limiting","limit":3,"sources":["web"]}'
```

No `Authorization` header anywhere — that is the point.

## How ultrasearch uses it

`ULTRASEARCH_FIRECRAWL` (or `--firecrawl <url>`) sets the base URL; it defaults
to `http://localhost:3002`, and `off` disables Firecrawl entirely. Nothing has to
be configured for the default stack.

Availability is decided by **one memoised 2s probe** of `GET /` per process. When
Firecrawl is down, every extraction falls back to the built-in reader exactly as
before, silently — the default base being absent is the normal case. A base you
asked for *explicitly* and did not get, or an instance that answers but fails a
scrape, does get a note in the dossier. Nothing here can fail a run.

`--backends firecrawl` / `--web-engine firecrawl` additionally use Firecrawl's
`/search` as a discovery backend. That is an **explicit** choice — the default
`auto` cascade never reaches for it.

Optional: set `ULTRASEARCH_FIRECRAWL_KEY` to send `Authorization: Bearer <key>`
and point the same client at Firecrawl Cloud instead.
