# Web discovery — your WebSearch is the engine, the cascade is the amplifier

Discovery has two lanes. Fetching and text extraction of the chosen URLs is
always done by the script, whichever lane found them.

## Lane 1 — your own WebSearch (the engine)

The best index in this pipeline, and the only one that needs neither a container
nor a scrape. The engine cannot call it — that tool lives in your harness — so
you run it and hand the hits over:

```
node <skill-dir>/scripts/ultrasearch.mjs queries --q "<question>" --mode <m> --depth <d>
# → run your WebSearch once per angle, pool every hit into one JSON array
node <skill-dir>/scripts/ultrasearch.mjs gather --q "<question>" --web-results <RUN>/websearch.json
```

`queries` sizes the sweep (2 · 4 · 8 distinct queries by depth) and names the
mode's angles. **One query is not a sweep**: a definition query and a criticism
query return different halves of the web, and pooling them is where the recall
comes from.

The payload is forgiving — `[{url,title,snippet}, …]`, a bare array of URL
strings, a `{results:[…]}` wrapper, or one URL per line; `-` reads stdin. Every
entry it cannot use is **counted and reported**, never silently dropped.

What the lane gets, and what it deliberately does not:

- **No trust privilege.** `claude` has no authority floor, exactly like every
  other discovery engine. There is no hostname table at all any more: `trust`
  reflects only the ROUTE a source arrived by, and judging the page is the
  reading agent's job.
- **No exemption from being read.** Hits carry no text, so each page is fetched,
  cleaned, wall-checked and hydrated through the same rescue ladder as any other
  candidate. A snippet never becomes evidence.
- **Nothing is displaced, because nothing is cut.** There is no source quota: a
  hit that passed hydration, the relevance floor and the near-duplicate collapse
  is in the dossier, full stop. `--max-sources` is an opt-in FETCH budget, unset
  by default, and whatever it leaves behind is reported.

## The two profiles (`--search`)

| `--search` | Your WebSearch lane | Mode API backends (Wikipedia, arXiv, Crossref, StackExchange, GitHub, HN, standards) | Keyless cascade (DDG, DDG Lite, Mojeek, Marginalia) | SearXNG | Firecrawl |
|---|---|---|---|---|---|
| `light` | ✅ the engine | ✅ | ❌ | ❌ | ✅ (extraction) |
| `full` | ✅ | ✅ | ✅ fused | ✅ if up | ✅ (extraction) |
| `max` | ✅ | ✅ | ✅ fused | ✅ if up | ✅ **also discovery** |
| `auto` *(default)* | `light` when you passed `--web-results` and pinned no `--web-engine`; `full` otherwise. Never `max` — ~3 GB of containers is always a decision. | | | | |

## `--search max` — the ceiling

`full`, plus three things:

- **Firecrawl's `/search` joins discovery.** It is excluded elsewhere because its
  upstream is the same SearXNG — but its hits can arrive *with* browser-rendered
  markdown, and `fuse` prefers the copy carrying text. So a duplicate URL comes
  back already read by a real browser instead of being re-fetched by the regex
  stripper.
- **Every recall knob at its limit**: `--pages 5`, `--web-breadth 5`,
  `--rounds 2`, `--per-source 50`. It supersedes a pinned `--web-engine` and
  says so. Measured on one question: 60 sources before `--per-source` was part
  of the ceiling, 188 after.
- **`--depth deep`**, unless you pinned a depth yourself.

It wants the whole stack (`docker compose --profile search --profile extract up
-d --wait`). A preflight warns before the run, and the dossier names whatever
was missing — a max run that silently degraded to full is the worst outcome
here, because it *looks* exhaustive.

> **`max` buys recall, and can cost precision.** Measured on two real runs of the
> same engine: on a `research` question it returned 60 sources with SearXNG
> contributing 19, 10 PDFs through the extractor ladder, and the papers ranked
> 1, 3, 5, 6, 7… On a `topic` question about a heavily-blogged subject it tripled
> the pool but pushed the WHATWG spec and the vendor API docs from ranks 6–21
> down to 27–57 — SEO posts written verbatim around the query out-score a
> specification that never uses the query's words. Reach for `max` on research
> and on decisions; on a commercial `topic`, `light` is the sharper tool.

Two consequences worth knowing:

- **Firecrawl stays on in `light`.** It *extracts* pages, it does not find them —
  so it keeps rescuing consent walls in either profile. Only SearXNG, a discovery
  engine, drops out.
- **`light` has no discovery engine**, so `--seed-domains` and `--rounds 2` have
  nothing to run their queries on. The run says so in its notes rather than
  pretending. Pass those hosts' pages in `--web-results`, or use `--search full`.
- **`auto` never regresses a harness without WebSearch.** No `--web-results` ⇒
  `full` ⇒ exactly the behaviour that existed before this lane did.

## Lane 2 — the keyless cascade (`--search full`)

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
   repo's `docker compose --profile search up -d` (a bare `docker compose up`
   starts nothing — every service is behind a profile). Public instances usually
   disable JSON output.
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

These are scrapers and free APIs: they rate-limit, they go empty, and their
markup shifts under them. The engine records each failure honestly in the notes
rather than hiding it. That is why they amplify lane 1 instead of replacing it.

## Topping up an existing dossier

A second WebSearch round folds in as one process, never one per URL:

```
node <skill-dir>/scripts/ultrasearch.mjs ingest --run <dossier-dir> --web-results <round2.json>
```

Each URL gets its own `S#` and its own outcome line — added, already present, or
refused with the reason. `fetch --url` remains the single-page form. Sources
ingested either way are stamped with the `claude` backend label for provenance.

## Pinning an engine

`--web-engine auto|searxng|firecrawl|ddg|ddglite|mojeek|marginalia|claude` —
`auto` (default) runs the fallback cascade above; a named engine pins to exactly
that one (injected even if the mode profile didn't list it); `claude` drops the
keyless engines so your `--web-results` lane IS the discovery — the same thing
`--search light` does, spelled as an engine.

Pinning is a deliberate request, so it **suppresses the `auto` inference**:
`--web-results` plus `--web-engine mojeek` resolves to `full`, not `light`, and
you get both lanes. Ask for `--search light` explicitly to override that.

`firecrawl` is **not** in the `auto` cascade and never will be: it needs a local
container stack, and its `/search` proxies the same SearXNG the `searxng` engine
already queries directly. Pin it (or `--backends firecrawl`) only when you want
Firecrawl's cleaned markdown to come back *with* the hits.

## Firecrawl — browser-rendered extraction (optional)

A self-hosted [Firecrawl](https://github.com/firecrawl/firecrawl) turns a page
into **main-content markdown using a real headless browser**. It is keyless
(`USE_DB_AUTHENTICATION=false`).

**What it actually buys, measured** — 14 varied documentation pages, self-hosted,
against the built-in reader: median **235 ms → 693 ms** per page (**≈3× slower**)
for **~30 % fewer** navigation-chrome markers overall. The average hides the
shape, and the shape is what matters: 3 of 13 pages improved clearly, 9 were
unchanged, 1 got slightly worse. Where it wins it wins big — nav preambles of 10,
13 and 29 lines collapsing to 0 — and it wins on pages the regex reader cannot
read at all: genuinely client-rendered SPAs, consent walls, anti-bot
interstitials. Plenty of framework docs sites are server-rendered, and the
built-in reader already handles those fine.

Read that as: **the payoff is concentrated in the junk-rescue tier below**, not
spread evenly over every fetch. If wall-clock matters more to you than the tail
of hard pages, leaving the stack down (or `--firecrawl off`) is a defensible
default — the built-in reader is not a fallback of last resort, it is adequate
for most pages.

```
docker compose --profile search --profile extract up -d --wait
```

Once it answers on `http://localhost:3002` (override with `--firecrawl <url>` or
`ULTRASEARCH_FIRECRAWL`; `off` disables it), it is used automatically:

- **Primary extraction.** Every HTML page goes to Firecrawl first; any failure
  falls back to the built-in reader. PDFs skip it entirely.
- **Junk rescue.** When an extraction trips the consent-wall / "enable
  JavaScript" / anti-bot detector, the page is re-extracted through Firecrawl
  before it is demoted to `⚠ snippet only`. This is the highest-value case —
  those pages contribute nothing today.
- **Silent when absent.** Availability is one memoised 2s probe per process. A
  missing default instance costs one refused connection and produces no note; an
  instance you configured explicitly and did not get produces exactly one.
- The dossier records how many pages it cleaned (`Firecrawl cleaned N page(s)…`),
  and the fetch cache keys on extractor identity, so bringing Firecrawl up is not
  masked by yesterday's natively-extracted entries.

> Firecrawl's markdown is **richer** than the stripped text, so it reaches the
> `--depth` extract caps (4k `summary` / 8k `standard`, uncapped on `deep`)
> sooner. If a long page reads as truncated, that is why — use `--depth deep`.

> **`--backends` is a bigger hammer than it looks.** It replaces the whole mode
> profile, and in doing so silently turns OFF four things: the resilient web
> cascade, `--seed-domains`, the `--rounds 2` gap round, **and `--web-engine`
> itself**. Use it to pin retrieval deliberately (`--backends fixture` for an
> offline run, `--backends mojeek,marginalia` to probe two indexes) — not as a
> way to "focus" a normal run. `gather` says so out loud: the run prints an
> `IGNORED:` line naming every flag the override voided, and records the same
> note in the manifest.

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

## Relevance floor (off-topic noise)

After fetch + content-aware re-ranking, `gather` drops candidates with **no
meaningful query-term overlap** — a page that matched nothing from the question,
matched only on a numeric false-friend (a year or a GitHub PR number sharing
digits with the query), or is a Wikipedia-style disambiguation stub ("… may
refer to:"). The filter never drops below the depth's recall floor, so a thin
genuine pool is kept intact; anything dropped is recorded in the dossier notes
(`Relevance floor dropped N off-topic result(s) …`).

Drop hosts you never want with `--exclude-domains a.com,b.com` — applied both
before the fetch and again **after redirects**, so a shortener can't smuggle an
excluded host back in.

## Topping up recall

- `--queries "phrasing one|phrasing two|exact term"` replaces the built-in query
  planner with your own variants (translate them yourself for a non-English
  search — the engine never translates).
- `--rounds 2` adds one gap-driven follow-up search for the question terms the
  first pass under-covered. Every run now *reports* those terms
  (`coverage.under` on the manifest, an `Under-covered` banner in `DOSSIER.md`);
  `--rounds 2` is what makes the engine act on them automatically instead of
  leaving the enrichment to you.
- `--pages <n>` (result pages per engine, ≤5) and `--web-breadth <n>` (engines
  fused, ≤5) both default by depth — raise them before reaching for
  `--max-sources`, which only widens the cut, not the search.

## Seeding primary domains

When you already know the authoritative hosts for a topic — a vendor's docs or
engineering blog — pass them so `gather` runs one extra targeted `site:<domain>`
search per host and ranks them as primary:
```
node <skill-dir>/scripts/ultrasearch.mjs gather --q "API Gateway rate limits" \
  --seed-domains docs.aws.amazon.com,developer.mozilla.org --out <dir>
```
Up to 3 domains, comma-separated. This is the fix for keyless discovery missing
a must-hit primary — the results still come from real searches (no synthetic
URLs). Major vendor/standards doc hosts are also trusted as primary by default.

## Fetching specific pages

You can always ground an exact page without discovery:
```
node <skill-dir>/scripts/ultrasearch.mjs fetch --url "https://docs.example.com/page" --out <dir>
```
The page is fetched, stripped to readable text, excerpted around the question's
keywords, assigned the next `S#`, and added to the dossier to cite.
