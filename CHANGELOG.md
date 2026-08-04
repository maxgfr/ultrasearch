# Changelog

All notable changes to this project are documented here, generated automatically from the [Conventional Commits](https://www.conventionalcommits.org/) by [semantic-release](https://github.com/semantic-release/semantic-release).

# [1.18.0](https://github.com/maxgfr/ultrasearch/compare/v1.17.1...v1.18.0) (2026-08-04)


### Features

* **websearch:** make the harness WebSearch the primary discovery engine ([69565df](https://github.com/maxgfr/ultrasearch/commit/69565df06c4277625eb5d0b1594e59a9ad142e19)), closes [#6](https://github.com/maxgfr/ultrasearch/issues/6)

## [1.17.1](https://github.com/maxgfr/ultrasearch/compare/v1.17.0...v1.17.1) (2026-08-03)


### Bug Fixes

* **searxng:** say when the instance is throttled, not that the query is empty ([96ad889](https://github.com/maxgfr/ultrasearch/commit/96ad889230c14ae1476fa547b87819c73d71e31b))

# [1.17.0](https://github.com/maxgfr/ultrasearch/compare/v1.16.0...v1.17.0) (2026-08-03)


### Features

* **pdf,services:** extractor ladder, and actually use SearXNG/Firecrawl ([d2447b2](https://github.com/maxgfr/ultrasearch/commit/d2447b26b6cdbf965db229567c04cc6fe452185b))

# [1.16.0](https://github.com/maxgfr/ultrasearch/compare/v1.15.0...v1.16.0) (2026-08-02)


### Features

* **relink:** expose it over MCP, and let the agent reconstruct a page ([261ffb6](https://github.com/maxgfr/ultrasearch/commit/261ffb62e7f3675456e909c2f46548bb87047197))

# [1.15.0](https://github.com/maxgfr/ultrasearch/compare/v1.14.0...v1.15.0) (2026-08-02)


### Features

* **sources:** cite pages, never API endpoints, and refuse anti-bot walls ([9dc4fe4](https://github.com/maxgfr/ultrasearch/commit/9dc4fe45bb6f5311e8b4bac2971848d1ec1885a6))

# [1.14.0](https://github.com/maxgfr/ultrasearch/compare/v1.13.0...v1.14.0) (2026-08-02)


### Features

* **cli:** run without touching the disk via --stdout ([94a55c5](https://github.com/maxgfr/ultrasearch/commit/94a55c5f7027191a2d406e679ac7ccc57b92b1e0))

# [1.13.0](https://github.com/maxgfr/ultrasearch/compare/v1.12.0...v1.13.0) (2026-07-29)


### Features

* **mcp:** serve ultrasearch over the Model Context Protocol ([be0d4ce](https://github.com/maxgfr/ultrasearch/commit/be0d4ceb40c2d5cf915ba278342ed8e041fcb9f8))

# [1.12.0](https://github.com/maxgfr/ultrasearch/compare/v1.11.0...v1.12.0) (2026-07-28)


### Features

* **firecrawl:** add self-hosted Firecrawl extraction and search ([dfaa736](https://github.com/maxgfr/ultrasearch/commit/dfaa736864f612db1219664c79d855407dd5ac02))

# [1.11.0](https://github.com/maxgfr/ultrasearch/compare/v1.10.0...v1.11.0) (2026-07-25)


### Bug Fixes

* **engine:** replace literal NUL separators with escapes, and guard against them ([8d984d0](https://github.com/maxgfr/ultrasearch/commit/8d984d0f80a9f095fedf074f610c0e79a504d974))


### Features

* **gather:** report what retrieval missed, and stop losing recall silently ([c031424](https://github.com/maxgfr/ultrasearch/commit/c031424bb94b8d2e1bba5a8de131b7891dc13c6c))
* make the ultrasearch skill a reference-grade artifact ([4090b8e](https://github.com/maxgfr/ultrasearch/commit/4090b8eae4d7fc213085e71984953c93321a4edf))

# [1.10.0](https://github.com/maxgfr/ultrasearch/compare/v1.9.3...v1.10.0) (2026-07-12)


### Features

* **gather:** fail loudly on an empty dossier instead of the happy next-steps ([043c810](https://github.com/maxgfr/ultrasearch/commit/043c810ffa3403eff763c44f167526d4d8e28936))

## [1.9.3](https://github.com/maxgfr/ultrasearch/compare/v1.9.2...v1.9.3) (2026-07-12)


### Bug Fixes

* **check:** table header rows are structure, not unsourced claims ([9f850c7](https://github.com/maxgfr/ultrasearch/commit/9f850c7ef70067c849b0990702cf6a397e75440e))

## [1.9.2](https://github.com/maxgfr/ultrasearch/compare/v1.9.1...v1.9.2) (2026-07-10)


### Bug Fixes

* **check:** fail closed when a cited claim's verdict is dropped (deep exit gate) ([50383bc](https://github.com/maxgfr/ultrasearch/commit/50383bc9d9ba70ae30550e869b77815b4dd579ee))
* **plan:** keep auto-generated sub-questions grammatical for clausal question forms ([03feced](https://github.com/maxgfr/ultrasearch/commit/03feced7d5165181e7f957d2861aefafe939e730))

## [1.9.1](https://github.com/maxgfr/ultrasearch/compare/v1.9.0...v1.9.1) (2026-07-09)


### Bug Fixes

* **orchestrate:** verified review findings — fail-closed fold, shell-safe emission, per-phase fan-out floor ([#12](https://github.com/maxgfr/ultrasearch/issues/12)) ([36a2f30](https://github.com/maxgfr/ultrasearch/commit/36a2f3060800a6601dc62457b60b31831fb3baed))

# [1.9.0](https://github.com/maxgfr/ultrasearch/compare/v1.8.0...v1.9.0) (2026-07-09)


### Features

* **orchestrate:** standard-depth orchestration by default — gather/verify fan-out (family round) ([#11](https://github.com/maxgfr/ultrasearch/issues/11)) ([7771428](https://github.com/maxgfr/ultrasearch/commit/77714283295cf38f41bca91bdf3ca852281d9f17))

# [1.8.0](https://github.com/maxgfr/ultrasearch/compare/v1.7.2...v1.8.0) (2026-07-08)


### Features

* implement eval-round feedback + brainstorm clarity gate ([18a727f](https://github.com/maxgfr/ultrasearch/commit/18a727f5c686a6de99bc430e022eb3a066f79a88))

## [1.7.2](https://github.com/maxgfr/ultrasearch/compare/v1.7.1...v1.7.2) (2026-07-07)


### Bug Fixes

* **engine:** harden parsers, isolate render inline formatting, guard the grounding gate ([5e05722](https://github.com/maxgfr/ultrasearch/commit/5e05722c4f77d26fd3f01ebed196c24a0f47c275))

## [1.7.1](https://github.com/maxgfr/ultrasearch/compare/v1.7.0...v1.7.1) (2026-07-07)


### Bug Fixes

* **backends:** stop silent data-loss + guard missing-field edge cases ([bd82528](https://github.com/maxgfr/ultrasearch/commit/bd82528f975dd868719cf72683fa4948a2f66177))

# [1.7.0](https://github.com/maxgfr/ultrasearch/compare/v1.6.0...v1.7.0) (2026-07-07)


### Features

* **engine:** P0 robustness & performance hardening ([2aaaf5b](https://github.com/maxgfr/ultrasearch/commit/2aaaf5b71ca62400ff3bc9ca66d7ba96971e2a24))
* **engine:** P1 power — dblp backend, Wayback rescue, opt-in fetch cache ([d9c12bc](https://github.com/maxgfr/ultrasearch/commit/d9c12bcb84481ac7c7d1608ee52169704ec29a11))

# [1.6.0](https://github.com/maxgfr/ultrasearch/compare/v1.5.3...v1.6.0) (2026-07-04)


### Features

* **report:** merge REPORT and FULL tiers into one complete report ([083d3de](https://github.com/maxgfr/ultrasearch/commit/083d3de1c2a1a7fb62d69ff23f9b9f0a7045d8d3))

## [1.5.3](https://github.com/maxgfr/ultrasearch/compare/v1.5.2...v1.5.3) (2026-07-02)


### Bug Fixes

* **cli:** complete --help, remove dead --fresh/--verbose, single-source web-engine values ([bda0979](https://github.com/maxgfr/ultrasearch/commit/bda0979216db79996bec20c1801d3e6c876727aa))
* **skill:** de-duplicate SKILL.md, anchor paths for installed skills, tighten description; gate doc↔CLI flag drift ([eb24b30](https://github.com/maxgfr/ultrasearch/commit/eb24b30da5d1a42e00109fadcf8156276903903d)), closes [Walkthrou#probe](https://github.com/Walkthrou/issues/probe)
* **skill:** harden drift gate & make every snippet installed-skill-safe (review findings) ([f8568a0](https://github.com/maxgfr/ultrasearch/commit/f8568a001428afc29842da103112b96c7231b8e0))

## [1.5.2](https://github.com/maxgfr/ultrasearch/compare/v1.5.1...v1.5.2) (2026-06-28)


### Bug Fixes

* **skill:** restore learn/startup/deep NL triggers in ultrasearch description (≤1024) ([848f0f9](https://github.com/maxgfr/ultrasearch/commit/848f0f9d75e86c005396de6094184ab98a3a2644))

## [1.5.1](https://github.com/maxgfr/ultrasearch/compare/v1.5.0...v1.5.1) (2026-06-28)


### Bug Fixes

* **skill:** package under skills/ultrasearch/ so `skills add` installs the whole skill ([8b9fb7a](https://github.com/maxgfr/ultrasearch/commit/8b9fb7a879e471d0ab9ad7f6a7973b87209bceba))

# [1.5.0](https://github.com/maxgfr/ultrasearch/compare/v1.4.0...v1.5.0) (2026-06-27)


### Features

* language-aware multi-page web search + consolidated markdown report ([882fa30](https://github.com/maxgfr/ultrasearch/commit/882fa300ea2ba05a0093290ae52f406fe602b786))

# [1.4.0](https://github.com/maxgfr/ultrasearch/compare/v1.3.0...v1.4.0) (2026-06-16)


### Bug Fixes

* **backends:** decode HTML entities and strip markup in Wikipedia/Crossref/Europe PMC ([b12e0ff](https://github.com/maxgfr/ultrasearch/commit/b12e0ff29667480d1f2588b2d5e4b2026eba24a1)), closes [#039](https://github.com/maxgfr/ultrasearch/issues/039)


### Features

* deep-research subagent orchestration + robustness signals ([479cb96](https://github.com/maxgfr/ultrasearch/commit/479cb969878c21d9a0d44e5bed0f3efbf89a304e))

# [1.3.0](https://github.com/maxgfr/ultrasearch/compare/v1.2.0...v1.3.0) (2026-06-15)


### Features

* deep research tier — decompose, merge, adversarial verify ([#5](https://github.com/maxgfr/ultrasearch/issues/5)) ([f0c49b9](https://github.com/maxgfr/ultrasearch/commit/f0c49b92bf113dbee0fa00d0508ca2909c461c29))

# [1.2.0](https://github.com/maxgfr/ultrasearch/compare/v1.1.0...v1.2.0) (2026-06-13)


### Features

* maximize search quality (BM25F, multi-engine cascade, full-text extraction) ([900c771](https://github.com/maxgfr/ultrasearch/commit/900c77157583215ed1825a3fd7c41ef2c154e558))

# [1.1.0](https://github.com/maxgfr/ultrasearch/compare/v1.0.0...v1.1.0) (2026-06-13)


### Features

* exhaustiveness upgrade — query variants, content re-rank, more backends; harden grounding gate ([997ef2a](https://github.com/maxgfr/ultrasearch/commit/997ef2a8259709745a044d9ede3722f60773717d))

# 1.0.0 (2026-06-13)


### Features

* ultrasearch — keyless web-research skill with grounded, tiered reports ([80f8b9c](https://github.com/maxgfr/ultrasearch/commit/80f8b9ccca036bc870b2c537951c5dbc01c0aac4))
