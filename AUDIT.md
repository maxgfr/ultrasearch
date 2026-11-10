# Code audit — November 2026

Scope: everything under `src/` except the vendored engine (`src/vendor/`, a pinned
artifact with its own repository), plus `scripts/`, `evals/` and the test suite.
Baseline: `9375ad4` (v1.45.1). The bug fixes shipped as **v1.45.2**; the
optimizations, the cleanup and the dblp fix as **v1.45.3**.

## Summary

1. The codebase is in good shape: strict TypeScript, 1359 offline tests, a coverage
   ratchet, a reproducible committed bundle, and every gate green before the audit
   started (typecheck, lint, tests, `check:build`, offline evals, demo).
2. The defects that mattered sat in the report gate: `render` could loop forever on
   ordinary markdown, and four report shapes let a claim past `check` or `verify`
   unexamined. All are fixed.
3. 29 bug-fix commits, each with a regression test; 4 optimizations, each measured;
   lint warnings 4 → 0; 2 dead functions removed. CI and the release workflow were
   green after both pushes.
4. Tests 1359 → 1411. Coverage up on every axis: statements 94.72 → 95.13 %,
   branches 85.41 → 85.93 %, functions 97.26 → 97.50 %, lines 96.52 → 96.85 %.
5. What remains is design work, not defects in a line: two commands overwrite an
   existing dossier without a guard, and nothing locks a dossier across processes.
   See "Not fixed" and "Open questions".

## Behavior changes to be aware of

Every fix below changes what a wrong input produces. These are the ones a user or a
calling agent can see on input that used to "work":

| Change | Before | After |
|---|---|---|
| `check` / `verify` numerals | `500` was found in a source saying `2,500`; `12` in `2012` | Must appear as a whole number. `--strict-numerals` fails more reports, and `numeralsAbsent` lists more figures. A longer decimal still matches (`12` in `12.4`). |
| `check` on CRLF reports | A `## Sources` list and code blocks counted as citations | Masked as in an LF report; a report with no citation of its own now fails. |
| `check` on tables headed `ID` / `Item` / `Ref` | First column always dropped from scoring | Dropped only when its cells are labels (≤ 3 words, no `[S#]`). |
| `queries` output | `gather --q "<question>"` | `gather --q '<question>'` (shell-quoted). |
| `--per-source 0.5` and other fractions below 1 | Accepted, floored to 0 | Rejected (`invalid --per-source "0.5"`). |
| `--exclude-domains www.Reddit.com` | Excluded nothing | Excludes `reddit.com` and its subdomains. |
| SearXNG with `--since` | Always `time_range=year` | `day` / `month` / `year` by the date's age, none for an older date. More results for an old `--since`. |
| `manifest.backendsUsed`, `timings` | A backend that ran twice was listed twice; only its last run was timed | Listed once; times add up. |
| A `sources.json` whose `extract` is absolute or holds `..` | Read, rewritten or deleted wherever it pointed | Refused by every command, with the offending path named. |
| `relink --id s3` | "s3 is not in this dossier" | Works (`drop` and `human` already took either case). |
| MCP `ultrasearch_verify` with `shards` but no `shard` | Returned stripe 0 as if it were the whole worklist | Refused, as the CLI does. |
| Wikipedia with a `--lang` that is not a language code | Used as the hostname | Falls back to `en`. |
| Notes from Stack Exchange and dblp | "returned no results" / "failed or empty (status 200)" | Says rate-limited, failed, or returned nothing. |
| `refs.bib` from a refcheck dossier | `author = {Gurney NT and …}` | `author = {Gurney, N. T. and …}`; citation keys start with the family name. |

## Bugs fixed

Each fix has a regression test that was run and seen failing on the previous code,
with four exceptions marked ¹ ² ³ and explained under the tables. Tests live in the
topic's existing file.

### Report gate and renderer

| Commit | File | Issue | Fix | Test |
|---|---|---|---|---|
| `45d63de` | `src/render.ts` | `mdToHtml` never advanced on a line both the heading/fence rule and the paragraph rule refused: `# ` (empty heading), or any fence in a CRLF file. `render` hung until the heap ran out, wedging the MCP server. | Normalize line endings; the paragraph rule always consumes its line. | `render.test.ts` — "terminates on an empty heading, a bare hash and CRLF input" ¹ |
| `f68258d` | `src/render.ts` | The renderer closed a fence on any line starting with the marker; `check` follows CommonMark. A 4-backtick block holding a 3-backtick one was code to `check` and prose to `render`: an unscored claim reached the HTML as body text. | The renderer reads the same `codeMask` as the gate. | "closes a fence where check closes it, never earlier" |
| `41b1024` | `src/render.ts` | `## Why C#` rendered as "Why C". | A closing run of hashes needs a space before it. | "keeps a trailing hash that belongs to the heading text" |
| `e3a5622` | `src/render.ts` | `VERIFY.json`'s `sourceId` went into an `href` unescaped, `verdict` into a class name; a source's `id`, `backend`, `domain`, `trust` were written raw. A non-http(s) source url became a live link. | Escape everything; an unknown verdict tints nothing; only web addresses become links. | "escapes a verdict's source id and verdict, and a source's id, backend and domain" |
| `c06b9d1` | `src/claims.ts` | Under a header reading `ID`, `Item` or `Ref`, the first cell of every row was dropped from scoring, sentence or not. A cited sentence there lost its `[S#]`, so `--require-verify` passed a claim nobody judged. | A header names an index only over label-like cells. | `claims-index.test.ts` — "keeps a first column of sentences even when its header reads like an index" |
| `f2771d2` | `src/claims.ts` | A trailing `\r` defeated the heading, fence and appendix masks: on a CRLF report the Sources listing counted as citations (measured: 4 citations instead of 1). | Normalize line endings where the report is masked. | `check.test.ts` — "masks the appendix and code fences of a CRLF report exactly as it does an LF one" |
| `5f04b99` | `src/check.ts`, `src/verify.ts` | The numeral check was a substring test. | `hasNumeral` in `src/claims.ts`: digits may not continue on either side. | `claims-numerals.test.ts` — "numerals are matched as whole numbers, not as substrings" (8 cases) |

### Dossier pipeline

| Commit | File | Issue | Fix | Test |
|---|---|---|---|---|
| `7bd0c77` | `src/templates.ts`, `src/modes/registry.ts` | `"toString" in EXTRA_TEMPLATES` is true; a manifest with such a template name printed "undefined" into DOSSIER.md. | `Object.hasOwn`; an unknown mode throws `unknown mode "…"`. | `templates.test.ts` — "never resolves a template name through Object.prototype" |
| `ad17460` | `src/drop.ts` | `drop` rewrote DOSSIER.md with the mode's template, ignoring `manifest.template` (refcheck's "verification", `ingest --template`). | `templateFor(manifest)`, as every other writer. | `drop.test.ts` — "rewrites DOSSIER.md with the template the dossier asked for" |
| `3b629ca` | `src/relink.ts` | `relink --id s3` failed where `drop`/`human` uppercase the id. | Normalize the id. | `relink.test.ts` — "takes a source id in either case" |
| `6bd0b0e` | `src/cli.ts` | `num()` tested `> 0` then floored: `0.5` became `0`. | Floor first, require ≥ 1. | `cli.test.ts` — "rejects a fraction below 1 instead of flooring it to 0" |
| `90d4734` | `src/gather.ts` | `--exclude-domains` / `--seed-domains` compared as typed against lowercased, `www.`-less hosts. | `hostList()` reduces both to the same form. | `gather.test.ts` — "matches a host however it was typed" (3 shapes) |
| `e1f0c84` | `src/gather.ts` | A Wayback rescue of a page that redirected to the home page (or a challenge) was cached with the original `finalUrl`; the gap round judged "redirected home" again, discarded the text and paid archive.org twice. | The cached rescue carries the address that was asked for. | `gather-rounds.test.ts` — "keeps the archived text in round 2" (2 availability calls → 1) |
| `a1d8931` | `src/gather.ts` | `backendsUsed` repeated a backend per run; `timings` kept the last run; SearXNG's contribution was read from its first run only. | Dedupe, sum, count across runs. | `gather-rounds.test.ts` (assertion + one inline snapshot line removed) |
| `7275cf9` | `src/dossier.ts` | A source's `extract` was joined onto the dossier directory unchecked: `"../x"` made `drop` delete and `relink` overwrite a file outside it (reproduced: the file was deleted). | `sourceIdentityError` refuses an absolute path or a `..` segment. | `drop.test.ts` — "refuses a source whose extract path escapes the dossier" (3 shapes) |
| `a9c5a26` | `src/gather.ts` | `mergeSameRecord` gave the winning copy the loser's `textVia`, `waybackSnapshot` and `extractor`. | The loser hands over record facts, not its read. | `gather.test.ts` — "mergeSameRecord" (2 tests) |

### Backends and enrichment

| Commit | File | Issue | Fix | Test |
|---|---|---|---|---|
| `df6468f` | `src/backends/europepmc.ts` | Entities decoded, then any `<…>` stripped: "p &lt; 0.05 … &gt;" lost the text in between. | Strip only what is shaped like a tag. | `backends-research.test.ts` — "keeps a literal less-than in an abstract" |
| `e77f180` | `src/backends/searxng.ts` | Any `--since` became `time_range=year`. | `searxngTimeRange()`: smallest covering window, or none. | `backends-searxng.test.ts` — "maps --since onto the smallest time_range that still covers it" ² |
| `14aa1c7` | `src/queries.ts`, `src/orchestrate-templates.ts` | The question (in `queries`) and the engine path (in the gatherer contract) were interpolated into printed shell commands unquoted. | `shq`. | `queries.test.ts`, `orchestrate.test.ts` (+ golden snapshot: 3 lines) |
| `06301e3` | `src/backends/wikipedia.ts` | `--lang` went into the hostname as typed; `evil.example/x?` sent the request to `evil.example` (reproduced). | 2–12 letters, lowercased, else `en`. | `backends-wikipedia-edge.test.ts` (5 hostile values) |
| `d706e24` | `src/backends/standards.ts` | The RFC title filter is a substring match but was given the two top-ranked words ("429 limiting"). | `titlePhrase()`: neighbouring keywords, numbers excluded. | `backends-standards.test.ts` — "searches RFC titles for a phrase a title can actually contain" ² |
| `d1b5bca` | `src/backends/stackexchange.ts` | A failed site returned `[]`; five throttled sites read "returned no results". | Read the error body; say rate-limited or failed. | `backends-stackexchange-edge.test.ts` (2 tests) |
| `42e5523` | `src/providers/ncbi.ts` | JATS paragraphs matched lazily to the first `</p>`: text after a nested list was lost. | Count opening and closing tags. | `ncbi.test.ts` — "keeps the text that follows a list nested in a paragraph" |
| `f195ca2` | `src/enrich.ts` | With `--cite-url`, `textVia` was re-pinned to an endpoint that had returned nothing when the cited page supplied the text. | Provenance is settled once, when the text is read. | `enrich.test.ts` — "does not credit an endpoint that returned nothing" |
| `2abe0e6` | `src/bibtex.ts` | The url field was written raw: braces closed it. An empty surname survived `??`. | Percent-encode braces; `\|\|`. | `bibtex-edge.test.ts` (2 tests) |
| `3937d4a` | `src/refcheck/index.ts`, `src/bibtex.ts` | Vancouver names ("Gurney NT") went into refs.bib as-is; BibTeX read the initials as the family name. | Store "Gurney, N. T."; build keys from the family name. | `refcheck.test.ts` (assertions on refs.bib) |
| `69222eb` | `src/refcheck/citing.ts` | "two and three eyes" was read as 5. | "and"/"et" joins only after a scale, or a French ten before un/onze. | `refcheck.test.ts` — "does not add up two numbers that an 'and' merely lists" |
| `f4d92e1` | `src/mcp/handlers.ts` | `ultrasearch_verify` took `shards` without `shard` for stripe 0. | The CLI's validation. | `mcp-handlers.test.ts` — "refuses half of a shard pair" |
| `86b7834` | `src/backends/dblp.ts` | "dblp search failed or empty (status 200)". | `apiFailure`, like the other scholarly backends. | `backends-research.test.ts` — "tells an empty answer, a throttle and a failure apart" ³ |

¹ Not run against the old code as a test — it would hang the runner. The hang was
reproduced beforehand on the committed v1.45.1 bundle (`render` still running after
6 s on a three-line report; killed).
² The test imports a helper the fix introduces, so it cannot load against the old
file. The old behavior was read in the source, and the assertion on the request URL
is the one the old code would fail.
³ Written together with the fix and only run after it; the old wording is the one
quoted in the Issue column.

## Optimizations

Measured with a throwaway benchmark (median of N runs, same machine, before and after
each change). Outputs are unchanged in every case; the equivalence is tested where
it is not obvious.

| Commit | Change | Before | After | Gain |
|---|---|---|---|---|
| `758d433` | `src/passages.ts` — the per-window boundary search used `lastIndexOf` over the whole text; with no line break it walked back to the start every time (quadratic). Now bounded to the half-window it serves. | 5 951 ms on a 3 MB single-line extract | 3.8 ms | ×1500 on that shape; nothing on text with regular line breaks |
| `8320a27` | `src/backends/wikipedia.ts` — each query variant re-read the summary of every page it found. Summary reads are memoized per run (the in-flight promise). | 21 requests for 3 variants over 6 pages | 9 | −57 % requests; grows with variants |
| `fff38ee` | `src/codes.ts` — per code mention, two more passes over the page (repeat count, sentence ends). Both computed once. | 201 ms on a 389 KB page, 12 codes × 40 mentions | 32 ms | ×6 |
| `30f95b5` | `src/relink.ts` — `autoRelink` re-scanned every extract each round. Scans are kept until a source's text changes. | 110 ms on 120 sources, 60 repairs, 30 KB extracts | 48 ms | ×2.3; the rest is writing the repaired extracts |

Assessed and left alone, because the measured cost does not justify a change:
`parsePepperThreads` (0.8 ms on the saved capture, though it builds one regex per
thread twice), the second read of REPORT.md in `check`, and the per-numeral abstract
normalization in refcheck.

## Quality

- `a9d0f31` — the four `biome ci` warnings are gone (a stale suppression, three comma
  operators in a test).
- `3c3ef85` — removed `isBrowserMode` and `efetchAbstracts`, which nothing calls.
- `95785c3` — an eval failure no longer prints "expected ≥undefined sources".
- Dependencies: `pnpm audit` reports no known vulnerability. Outdated: biome 2.6.3 →
  2.6.6, `@types/node`, vite (patch), vitest 4 → 5 (major). Left to dependabot; the
  vitest major deserves its own PR because the coverage thresholds are tuned to v4.

## Not fixed

Each item was confirmed by running it, unless marked otherwise.

### Critical

None.

### Important

1. **`gather` and `merge` overwrite an existing dossier without a guard.**
   `src/dossier.ts` `writeDossier`. A second `gather --out D` renumbers from S1:
   in a probe, `S1` went from `a.test` to `c.test` while the REPORT.md already there
   still cited `[S1]`, and the old `S2.md` / `S3.md` stayed on disk. `droppedIds` is
   lost too, which defeats the dangling-citation protection `drop` relies on.
   Recommendation: refuse when `D` holds a REPORT.md or SUMMARY.md unless `--force`
   is passed (refcheck already does exactly this).
2. **No lock across processes on a dossier.** `withRunLock` is in-process and used
   by the MCP server only. Two `fetch --out D` in parallel both read the highest id
   and allocate the same `S#`; the last writer wins. Writes are atomic per file, so
   nothing is torn — a source is silently lost. (Read in the code, not reproduced.)
   Recommendation: an `O_EXCL` lock file in the dossier for every writing command.
3. **refcheck turns wrapped reference lines into references.** `src/refcheck/parse.ts`.
   "2020 Mar;382(5):100-110." on its own line becomes reference 2020, and the real
   reference loses its year and pages; a repeated number yields a duplicate `S<n>`
   that `check` then rejects for the whole dossier. Recommendation: accept a new
   number only when it continues the sequence (previous + 1, or the first).
4. **Two DOI identity implementations disagree.** `src/identity.ts` (`doiKey`) strips
   trailing punctuation and percent-decodes; `src/util.ts` (`identityKey`) does
   neither: `https://doi.org/10.1000/ABC%2Fdef.` gives `doi:10.1000/abc/def` in one
   and `doi:10.1000/abc/def.` in the other. `merge` uses one, `gather`/`enrich` the
   other, so one paper can stay two sources. Recommendation: one function, in the
   engine, and bump `minRef` in the same commit.
5. **Stacked retries on the PubMed efetch path.** `src/providers/ncbi.ts`
   `readNcbiDocument` wraps `readPastCachedWall` in `withBackoff`, but the engine read
   has its own retry (and a second User-Agent attempt) that cannot be switched off
   from here, and those inner attempts are not paced. One PMID can cost several
   unpaced E-utilities calls. Needs a `retries` option on the engine's
   `fetchAndExtract`. (Read in the code, not measured.)

### Minor

6. `src/refcheck/citing.ts` — an unknown call number raises the bar for every later
   first citation: `[1] … [99] … [2] … [3]` reports 2 and 3 as "out of order after
   99". An existing test pins this behavior, so it is listed under open questions.
7. `src/codes.ts` — "Profitez des 10€ de remise" reads `des` as `dès` and files 10 €
   as the minimum spend, with no discount. `des` is accepted on purpose for
   unaccented input; requiring "d'achat" / "de commande" after the amount in that
   case would separate the two.
8. `src/walls.ts` — `--search max` flips the engine's cache mode process-wide while
   it re-reads one walled page, so the other hydration workers skip the disk cache
   for that window. Correct, only wasteful. Needs a per-read option in the engine.
9. `src/backends/pepper.ts` — `num(t.price) ? … : …` drops a price of 0 (a free
   deal), and the "expired" count in the note covers threads the slice dropped.
10. `src/brainstorm.ts` — `if (qs.length < 4)` is always true at that point.
11. Unused re-exports in the facade modules (`backends/firecrawl.ts`, `backends/pdf.ts`,
    `backends/doc.ts`, `cache.ts`, `walls.ts`, `check.ts`, `mcp/handlers.ts`). Left
    in place: they are declared as the engine's public surface, and trimming them
    lowers the "engine symbols in use" count that `verify-engine-usage` ratchets.
12. `scripts/sync-version.mjs` only warns when one of its version regexes stops
    matching, so a release could ship with a stale version in the bundle or SKILL.md.
    Not touched (release tooling); it should exit non-zero.
13. `--search max` raises a lower explicit `--per-source` to 50 without listing it
    among the flags the profile ignored.

## Open questions

These need a decision; none was guessed.

1. **Should `gather` / `merge` refuse an existing dossier that holds a report?**
   (Important #1.) A `--force` guard is a behavior change for anyone who re-gathers
   into the same directory on purpose — which the help text describes as a workflow.
2. **Should `apiGet` retry 502/504 and timeouts?** `src/backends/backoff.ts` switches
   the engine's retry off (`retries: 0`) so the two loops never stack, but its own
   loop only waits out 429/503. A single 502 from Crossref, OpenAlex, Europe PMC,
   Semantic Scholar or ClinicalTrials.gov now fails that backend for the variant,
   where the engine used to retry once.
3. **Should a single-URL `fetch` look up the arXiv record?** `addSources` (ingest)
   does; `addSource` (`fetch`, `add-source`, MCP) does not, so
   `fetch --url https://arxiv.org/abs/…` banks a source with no authors or year and
   it is left out of `refs.bib`. Fixing it adds one arXiv API call per such fetch.
4. **Should the browser rung stay off under `CI`?** `src/browser.ts` `canShowWindow`
   returns true on macOS/Windows whatever the environment; the engine's own check
   returns false when `CI` is set. On a macOS CI runner with Chrome installed the
   default rung would open a browser while `human` reports that no window can be
   shown. Reusing the engine's function resolves it, if that is the intent.
5. **Is the "out of order after an unknown number" cascade intended?** (Minor #6.)
6. **Should `--since` reach the scholarly backends?** PubMed, Europe PMC, Semantic
   Scholar, dblp and arXiv all have date filters and ignore the flag. The help calls
   it a hint "where a backend supports it", so this may be deliberate.
7. **Should the MCP server confine path arguments to a root?** `run`, `out`,
   `run_root`, `master` and refcheck's `refs` accept any absolute path. That is the
   CLI's contract too, and an MCP client is normally the user's own agent — but a
   configured root would make the server safe to expose to a less trusted client.
