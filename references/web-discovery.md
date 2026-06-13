# Web discovery — layered, keyless, with a WebSearch bridge

For the general-web part of a run (`searxng`, `duckduckgo`), discovery is layered
and entirely keyless/free. Fetching and text extraction of the chosen URLs is
always done by the script.

## The layers (`--web-engine auto`, the default)

1. **SearXNG (local).** If reachable (default `http://localhost:8888`, override
   with `--searxng` or `ULTRASEARCH_SEARXNG`), queried over its JSON API
   (`/search?format=json`). Self-hosted metasearch, no key. Bring one up with the
   repo's `docker-compose up`. Public instances usually disable JSON output.
2. **DuckDuckGo HTML.** Scrapes `html.duckduckgo.com/html` and decodes the real
   URLs from DDG's redirector. Autonomous and keyless; fragile if DDG changes
   markup, and can rate-limit.
3. **Your WebSearch (the bridge).** The keyless layers are best-effort. Use your
   own **WebSearch** tool to find the authoritative URLs they miss, then ingest
   each one:
   ```
   node scripts/ultrasearch.mjs fetch --url "<url>" --out <dossier-dir>
   ```
   This is not a fallback of last resort — it's the recommended way to reach
   primary sources and exactly the pages the user cares about. Ingested sources
   are stamped with the `claude` backend label for provenance.

## Pinning an engine

`--web-engine searxng|ddg|claude|auto` — `auto` (default) tries SearXNG then
DuckDuckGo. (Backends are also selectable directly with `--backends`.)

## Fetching specific pages

You can always ground an exact page without discovery:
```
node scripts/ultrasearch.mjs fetch --url "https://docs.example.com/page" --out <dir>
```
The page is fetched, stripped to readable text, excerpted around the question's
keywords, assigned the next `S#`, and added to the dossier to cite.
