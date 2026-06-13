# Web discovery — a keyless fallback cascade, with a WebSearch bridge

For the general-web part of a run, discovery is a resilient **fallback cascade**
across several keyless/free engines. Fetching and text extraction of the chosen
URLs is always done by the script.

## The cascade (`--web-engine auto`, the default)

Engines are tried in order and the cascade **short-circuits as soon as one
returns enough results** (so the later engines are only queried when an earlier
one is empty, blocked, or rate-limited). A note records which engines were tried
and which produced, so you can see when results came from a fallback.

1. **SearXNG (local).** If reachable (default `http://localhost:8888`, override
   with `--searxng` or `ULTRASEARCH_SEARXNG`), queried over its JSON API
   (`/search?format=json`). Self-hosted metasearch, no key. Bring one up with the
   repo's `docker-compose up`. Public instances usually disable JSON output.
2. **DuckDuckGo HTML.** Scrapes `html.duckduckgo.com/html` and decodes the real
   URLs from DDG's redirector. Autonomous and keyless; fragile if DDG changes
   markup, and can rate-limit.
3. **DuckDuckGo Lite.** Scrapes `lite.duckduckgo.com/lite` — a flatter, simpler
   results table that tends to survive markup changes better than the main HTML
   endpoint, so it's the first DDG fallback.
4. **Mojeek.** Scrapes `mojeek.com/search`. An independent crawler/index (not a
   Bing/Google reseller), so it surfaces pages the DDG family misses.
5. **Marginalia.** Queries the free public JSON API
   (`api.marginalia-search.com`). Indexes the non-commercial, text-first
   long-tail web the big engines under-surface — broad-recall final fallback.
6. **Your WebSearch (the bridge).** The keyless layers are best-effort. Use your
   own **WebSearch** tool to find the authoritative URLs they miss, then ingest
   each one:
   ```
   node scripts/ultrasearch.mjs fetch --url "<url>" --out <dossier-dir>
   ```
   This is not a fallback of last resort — it's the recommended way to reach
   primary sources and exactly the pages the user cares about. Ingested sources
   are stamped with the `claude` backend label for provenance.

## Pinning an engine

`--web-engine auto|searxng|ddg|ddglite|mojeek|marginalia|claude` — `auto`
(default) runs the fallback cascade above; a named engine pins to exactly that
one (injected even if the mode profile didn't list it); `claude` drops web
discovery so you drive it via your own WebSearch. (Backends are also selectable
directly with `--backends`, e.g. `--backends mojeek,marginalia`.)

## Fetching specific pages

You can always ground an exact page without discovery:
```
node scripts/ultrasearch.mjs fetch --url "https://docs.example.com/page" --out <dir>
```
The page is fetched, stripped to readable text, excerpted around the question's
keywords, assigned the next `S#`, and added to the dossier to cite.
