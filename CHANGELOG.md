# Changelog

All notable changes to this project are documented here, generated automatically from the [Conventional Commits](https://www.conventionalcommits.org/) by [semantic-release](https://github.com/semantic-release/semantic-release).

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
