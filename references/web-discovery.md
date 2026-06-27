# Web discovery — a keyless fallback cascade, with a WebSearch bridge

For the general-web part of a run, discovery is a resilient **fallback cascade**
across several keyless/free engines. Fetching and text extraction of the chosen
URLs is always done by the script.

## The cascade (`--web-engine auto`, the default)

Engines are tried in order. How many are used depends on **breadth**, scaled by
`--depth` (override with `--web-breadth <n>`):

- **`summary` → breadth 1:** the cascade **short-circuits** as soon as one engine
  returns enough results — later engines run only when an earlier one is empty,
  blocked, or rate-limited (the original, cheapest behaviour).
- **`standard` → breadth 2, `deep` → breadth 5 (all engines):** the cascade keeps
  going until that many engines have each returned enough, then **fuses** their
  results (RRF over identity). Querying several independent indexes widens recall;
  thin engines are still fused, never dropped.

Each engine also fetches **multiple result pages** per query, scaled by `--depth`
(`summary` 1 · `standard` 2 · `deep` 3; override with `--pages <n>`, max 5). A
backend stops paginating early as soon as a page adds no new URLs, so an engine
that ignores the page offset costs at most one extra request. A note records
which engines were tried/fused, so you can see where results came from.

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

## Language & region

Search the audience's language, not yours. **You** (the agent) infer the target
language/region from the question or market and translate the query — the engine
never calls a translation API. Pass:

- `--lang <code>` — the search language (e.g. `de`). Drives Wikipedia's language
  subdomain (`de.wikipedia.org`), SearXNG's `&language=`, DuckDuckGo's `kl` region
  code, and an `Accept-Language` header on **every** request (search + page fetch).
  Translate `--queries` into this language too — the locale params only help if the
  query words are in the target language.
- `--region <cc>` — optional country override when it differs from the language
  (e.g. English content for a German market: `--lang en --region de`). Defaults to
  the country implied by `--lang`.

Per-engine support: SearXNG `&language=` ✓ · Wikipedia language subdomain ✓ ·
DuckDuckGo / DDG Lite `kl=<region>-<lang>` ✓ · Mojeek and Marginalia have no
reliable URL locale knob, so they rely on the `Accept-Language` header (Marginalia
is English-centric — treat its hits accordingly). Scholarly APIs (arXiv, Crossref,
…) are language-agnostic metadata services and are left unchanged.

The dossier is the evidence; **write the report in the user's own language** even
when the sources are in another — quote the original and gloss it where helpful.

## Fetching specific pages

You can always ground an exact page without discovery:
```
node scripts/ultrasearch.mjs fetch --url "https://docs.example.com/page" --out <dir>
```
The page is fetched, stripped to readable text, excerpted around the question's
keywords, assigned the next `S#`, and added to the dossier to cite.
