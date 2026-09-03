# Changelog

All notable changes to this project are documented here, generated automatically from the [Conventional Commits](https://www.conventionalcommits.org/) by [semantic-release](https://github.com/semantic-release/semantic-release).

# [1.33.0](https://github.com/maxgfr/ultrasearch/compare/v1.32.1...v1.33.0) (2026-09-03)


### Features

* **engine:** re-pin vendored engines ([d5ee761](https://github.com/maxgfr/ultrasearch/commit/d5ee761577ea639efe548f48c500b7ebe0288178))

## [1.32.1](https://github.com/maxgfr/ultrasearch/compare/v1.32.0...v1.32.1) (2026-09-03)


### Bug Fixes

* **gather:** keep wayback provenance when an alternate is served from the cache ([382666f](https://github.com/maxgfr/ultrasearch/commit/382666fab950d24b5617cb80d60d9788aa0a8792))


### Performance Improvements

* **check:** parse REPORT once and read each cited extract once ([b47366c](https://github.com/maxgfr/ultrasearch/commit/b47366c63fb989cedee8406d3c890006953812bb))
* **enrich:** read and write the dossier index once per ingest batch ([edfa96e](https://github.com/maxgfr/ultrasearch/commit/edfa96ec74fff4a691a362f25358b6d4e9c9171a))
* **gather:** fold wayback rescues into the hydrate cache and dedupe fetches in flight ([2638bd1](https://github.com/maxgfr/ultrasearch/commit/2638bd1f61350ec91f4d41bde771f557c393efb6))
* **generic:** fetch explicit urls in parallel through the cached fetcher ([596daca](https://github.com/maxgfr/ultrasearch/commit/596daca0b90c97d7a02c00f87d90ce03d278980d))
* **relink:** repair in memory and write the index once ([c3850d2](https://github.com/maxgfr/ultrasearch/commit/c3850d2184ccba66315931373d03da225642a2bc))
* **render:** load the context only when a writer runs ([4f5b611](https://github.com/maxgfr/ultrasearch/commit/4f5b611842f1c0c754a92a81a7f0fdd6d5bf4d02))
* **render:** load the dossier context once for html and markdown ([341f075](https://github.com/maxgfr/ultrasearch/commit/341f0753275f9994b1703fcccb27c66651d49a6b))
* **services:** probe only what the caller needs, in parallel ([6238ee8](https://github.com/maxgfr/ultrasearch/commit/6238ee8c3f695e2b5c3d325d1072a985609e465f))
* **verify:** digest only the pairs that survive the cap and shard ([950aff7](https://github.com/maxgfr/ultrasearch/commit/950aff79a36fb75febc28c7ec979842abc53dc21))

# [1.32.0](https://github.com/maxgfr/ultrasearch/compare/v1.31.0...v1.32.0) (2026-09-02)


### Features

* **engine:** re-pin vendored engines ([6167518](https://github.com/maxgfr/ultrasearch/commit/61675188b68eae23eec72240dcc92207e068da2c))

# [1.31.0](https://github.com/maxgfr/ultrasearch/compare/v1.30.0...v1.31.0) (2026-08-31)


### Features

* **engine:** re-pin vendored engines ([2198156](https://github.com/maxgfr/ultrasearch/commit/2198156c242bf2d262dd14d60bd89adc08aa2dc5))

# [1.30.0](https://github.com/maxgfr/ultrasearch/compare/v1.29.1...v1.30.0) (2026-08-26)


### Features

* **engine:** re-pin vendored engines ([9c17e83](https://github.com/maxgfr/ultrasearch/commit/9c17e83b136ff975b99918eea026af0d1269bd8f))

## [1.29.1](https://github.com/maxgfr/ultrasearch/compare/v1.29.0...v1.29.1) (2026-08-25)


### Bug Fixes

* make ultrasearch compatible with Codex ([ae62370](https://github.com/maxgfr/ultrasearch/commit/ae623708d5e9d25b0bff878b4799a88734c57104))

# [1.29.0](https://github.com/maxgfr/ultrasearch/compare/v1.28.0...v1.29.0) (2026-08-22)


### Features

* **engine:** re-pin vendored engines ([e8c0f1e](https://github.com/maxgfr/ultrasearch/commit/e8c0f1e21b5911b329ec91f2db55a7f6cb84e299))

# [1.28.0](https://github.com/maxgfr/ultrasearch/compare/v1.27.0...v1.28.0) (2026-08-10)


### Bug Fixes

* **build:** regenerate the example dossier before diffing it ([376d900](https://github.com/maxgfr/ultrasearch/commit/376d900309605a1efaefb781fee763c9718073b6))


### Features

* **engine:** re-pin webindex to v1.18.1 ([c44639e](https://github.com/maxgfr/ultrasearch/commit/c44639e38cc12a43495fc934925e39fd0c34b800))

# [1.27.0](https://github.com/maxgfr/ultrasearch/compare/v1.26.0...v1.27.0) (2026-08-10)


### Features

* **engine:** re-pin vendored engines ([efb9709](https://github.com/maxgfr/ultrasearch/commit/efb970991ec7ef519b7a8fc0ca0e13e435c291fb))

# [1.26.0](https://github.com/maxgfr/ultrasearch/compare/v1.25.2...v1.26.0) (2026-08-10)


### Features

* **engine:** adopt webindex v1.15's harness layer ([65f2693](https://github.com/maxgfr/ultrasearch/commit/65f269393008dabb7692a88068c3e4f9273c072b))

## [1.25.2](https://github.com/maxgfr/ultrasearch/compare/v1.25.1...v1.25.2) (2026-08-09)


### Bug Fixes

* **engine:** ship the v1.14.0 extraction fixes to installed skills ([db476d6](https://github.com/maxgfr/ultrasearch/commit/db476d6544685b8775124b5d35d30bc7c95b88bd))


### Reverts

* **engine:** do not vendor the engine's reference docs ([2e39463](https://github.com/maxgfr/ultrasearch/commit/2e3946329438dc9d71247a67a57106e54ab2133a))

## [1.25.1](https://github.com/maxgfr/ultrasearch/compare/v1.25.0...v1.25.1) (2026-08-09)


### Bug Fixes

* **gate:** count ./engine.js imports, and see unexported shadows ([1710ce0](https://github.com/maxgfr/ultrasearch/commit/1710ce01ca054b8cc35e636251b650017bfb24ea))

# [1.25.0](https://github.com/maxgfr/ultrasearch/compare/v1.24.0...v1.25.0) (2026-08-08)


### Features

* **engine:** re-pin vendored engines ([68fde37](https://github.com/maxgfr/ultrasearch/commit/68fde370c63d214124fdf1c8047e8763ebe0efd4))

# [1.24.0](https://github.com/maxgfr/ultrasearch/compare/v1.23.0...v1.24.0) (2026-08-08)


### Features

* **engine:** re-pin vendored engines ([c0d139c](https://github.com/maxgfr/ultrasearch/commit/c0d139caa3b727b8ceab687220dd7144e17e1a75))

# [1.23.0](https://github.com/maxgfr/ultrasearch/compare/v1.22.1...v1.23.0) (2026-08-07)


### Features

* **pdf:** read scanned PDFs with copyable-pdf, the ladder's OCR rung ([cee188d](https://github.com/maxgfr/ultrasearch/commit/cee188d3bbfd8f5ad9188341a720b2bc5e206a6e))

## [1.22.1](https://github.com/maxgfr/ultrasearch/compare/v1.22.0...v1.22.1) (2026-08-07)


### Bug Fixes

* **pdf,doc:** pin the npx extractor rungs instead of floating on latest ([1087e4c](https://github.com/maxgfr/ultrasearch/commit/1087e4c1698a3fdaa8dbb264466a4a13aa12a4eb))

# [1.22.0](https://github.com/maxgfr/ultrasearch/compare/v1.21.0...v1.22.0) (2026-08-07)


### Features

* **doc,ingest:** read office documents instead of citing their bytes ([69cd482](https://github.com/maxgfr/ultrasearch/commit/69cd482d5b447be7e95dc627f2552381f157f237))

# [1.21.0](https://github.com/maxgfr/ultrasearch/compare/v1.20.0...v1.21.0) (2026-08-04)


### Features

* **search:** put --per-source in the max ceiling, and purge the stale trust docs ([3b85caf](https://github.com/maxgfr/ultrasearch/commit/3b85caf42dc5b3ab5b14464656c88d24d94d8b16))

# [1.20.0](https://github.com/maxgfr/ultrasearch/compare/v1.19.1...v1.20.0) (2026-08-04)


### Features

* **gather:** no FETCH budget by default — --max-sources becomes opt-in ([9d356ff](https://github.com/maxgfr/ultrasearch/commit/9d356ff2e46254ba5f555f9ca7846fd5a8c4aa02))

## [1.19.1](https://github.com/maxgfr/ultrasearch/compare/v1.19.0...v1.19.1) (2026-08-04)


### Bug Fixes

* **gather:** say when discovery found more candidates than the run fetched ([80e154b](https://github.com/maxgfr/ultrasearch/commit/80e154b57f9cb49fd9f561bc77df1ff00dcf8ea9))

# [1.19.0](https://github.com/maxgfr/ultrasearch/compare/v1.18.0...v1.19.0) (2026-08-04)


### Features

* **rank:** order for diversity, and report source facts instead of verdicts ([51503e4](https://github.com/maxgfr/ultrasearch/commit/51503e43b6e14736ec4aaec0339177ee0b467f94))

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
