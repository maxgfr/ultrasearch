# Deep research playbook (the agentic tier)

The standard workflow is one `gather` + one report + a mechanical `check` — fast
(~3 min), reproducible, but a single pass. The **deep tier** grafts a
deep-research harness onto that same keyless engine: decompose the question →
fan out a sub-search per facet → merge into one dossier → adversarially verify
every claim against its source → loop until nothing new surfaces. It is slower
(10–20 min) but far more thorough and trustworthy.

The retrieval substrate stays deterministic and keyless — the agent supplies
judgement (decomposition, enrichment, report writing, verdicts, completeness);
the CLI supplies determinism (fan-out retrieval, fusion, merge, claim extraction,
gating). No LLM calls and no API keys are added.

## Contents

- Portability contract — CLI-only steps; subagents are optional
- The loop — decompose → fan out → merge → write → verify → gate → loop → render
- Fan-out subagent contract — the copy-paste dispatch prompt
- Parallel verification — sharded skeptics + reassembly
- Signals to act on — thin dossier · snippet-only · contradiction
- Mapping to a harness workflow
- Budget — the `DEEP_CAPS` bounds

## Portability contract

Every step is a plain `node <skill-dir>/scripts/ultrasearch.mjs …` call
(`<skill-dir>` = this skill's absolute directory, per SKILL.md). Parallel
subagents are an **optimization, not a requirement**:

- **Harness with subagents** (e.g. Claude Code): dispatch one subagent per
  sub-question for the fan-out, and skeptic subagents (one per verify shard) for
  verification. Concrete, copy-pasteable contracts are below
  ("Fan-out subagent contract", "Parallel verification").
- **No subagents**: run the same commands in a sequential loop. Identical
  artifacts; only wall-clock differs.

Write the orchestration so it degrades gracefully — never make a step depend on a
specific runtime. The CLI gives you everything the parallel path needs to stay
deterministic: `plan --run-root` hands you the sub-run dirs up front (no parsing
stdout), and `verify --shards` + multi-file `verify --apply` split and reassemble
the verification worklist.

## The loop

1. **Decompose** — `plan --q "<question>" --mode <m> --run-root <dir>` →
   sub-questions (JSON). Each mode-template facet becomes a genuinely
   interrogative sub-question about the SUBJECT (scaffolding like "deep research
   on …" is stripped) — e.g. "How does &lt;subject&gt; work under the hood?",
   "What are the main variants and approaches …?" — with facet-specific,
   cross-facet-deduplicated queries, so the fan-out searches differently per
   angle rather than re-issuing one query. Plus any identifiers in the question.
   Override with `--subquestions "a|b|c"` when you can do better. Bounded by
   `DEEP_CAPS.maxSubQuestions` (6). With `--run-root` each sub-question carries a
   deterministic `out` dir (`<dir>/q1`, `<dir>/q2`, …) and the plan is written to
   `<dir>/PLAN.json` — so you can dispatch the fan-out without parsing stdout.

2. **Fan out** — one `gather --depth deep --cache --out <its out dir>` per
   sub-question, passing that sub-question's `queries`. `--cache` shares an
   on-disk fetch cache across the sub-questions, so overlapping URLs are fetched
   once instead of once per sub-question. Enrich each thin area with your own
   WebSearch + `fetch` (the standard "bridge"); a sub-dossier under the recall
   floor is flagged in its `DOSSIER.md`, so enrich it before it feeds the merge.
   Parallel when possible (see the contract below), sequential otherwise.
   **Carry the locale through every fan-out** (`--lang`/`--region`, translated
   `queries`); report in the user's language — SKILL.md's locale rule.

3. **Merge** — `merge --runs "<run1,run2,…>" --master <masterDir> --q "<original question>" --mode <m>`. Re-fuses the
   combined pool by identity (DOI/arXiv/URL collapses cross-sub-question
   duplicates), drops near-duplicate content, records which sub-question(s)
   surfaced each source (provenance), and re-assigns **stable `S#` ids by fused
   rank**. Deterministic given the same inputs.

   > **Cite only the MASTER ids.** Sub-run dossiers all start at `S1`, so their
   > ids collide and are meaningless after merge. Write the report against the
   > master `DOSSIER.md` only.

4. **Write** the tiers (SUMMARY/REPORT) against the master dossier — same
   grounding contract as always (`[S#]` per claim, `[M]` for your own knowledge).

5. **Verify** — `verify --run <masterDir>` extracts every `(claim, [S#])` pair
   (using the *same* parser as `check`, so the worklist and the gate agree) and
   writes `VERIFY.todo.json` + `VERIFY.md`, each pair carrying a claim-focused
   digest of the cited extract. For each pair, open `sources/S#.md` and judge
   whether the source actually **supports** the claim:

   - `supported` — the source states the claim.
   - `partial` — it supports part / a weaker version.
   - `unsupported` — it doesn't address the claim.
   - `refuted` — it contradicts the claim.

   **Numeral rule:** if the claim asserts a specific numeral, date, or quantity
   (e.g. "10,000 rps", "5,000-request burst", "2017") that does NOT appear in
   the cited extract, the verdict is at most `partial` — never `supported` —
   even if the qualitative claim holds. The worklist precomputes this per pair
   (a `numeralsAbsent` field + a `⚠ Numerals not found` line in `VERIFY.md`), so
   a correct-but-mis-attributed figure can't slip through. Either find the
   figure in the full source, re-cite the page that carries it, or downgrade.

   Fill each `verdict` (+ a short `note`) and save as `verdicts.json`. Capped at
   `DEEP_CAPS.maxVerify` (40) pairs, highest-trust sources first. To fan the
   adjudication out, `verify --shards <N> --shard <i>` writes only shard `i`
   (`VERIFY.todo.<i>.json`) — a disjoint, deterministic slice — one per skeptic
   subagent ("Parallel verification" below).

6. **Gate** — `verify --apply <verdicts.json | dir | a,b,c> --run <masterDir>`
   then `check --semantic --require-verify --run <masterDir>`. `--apply` accepts
   one file, a directory, or a comma list, so sharded verdicts reassemble cleanly
   (merged by `(claimId, sourceId, file)`, last-wins). A claim fails if its source
   **refutes** it, or if every cited source is **unsupported** (nothing backs it).
   The semantic gate re-derives its verdict from `VERIFY.json`'s `verdicts[]`
   at check time — a stored `ok` flag is never trusted, so a hand-edited or
   stale summary can't flip the outcome. Both `--semantic` and
   `--require-verify` make a missing/unreadable/unadjudicated `VERIFY.json` a
   hard failure, so the gate can't silently pass when you forgot to run/apply
   `verify` (drop `--semantic` if you only want the mechanical gate).
   The gate also surfaces **contradictions** — claims whose own cited sources
   disagree (one supports, another refutes) — as a warning + a panel in the HTML,
   even when the claim still passes overall. Fix the claim (re-cite, weaken, drop,
   or `fetch` a better source) and re-verify until the gate passes.
   `check --semantic --require-verify` is the unified exit gate: mechanical
   grounding **and** semantic support. Add `--min-sources <n>` to also fail a
   too-thin master.

7. **Loop until dry** — inspect the master dossier + report for residual gaps,
   contradictions, or new sub-questions a round surfaced. If any appear and you
   are under the round budget (`DEEP_CAPS.maxRounds`, 3), fan out the new
   sub-questions, `merge` them into the **same** master, and re-verify: `verify`
   regenerates the worklist afresh (prior verdicts are NOT carried over), so
   adjudicate the new pairs into a fresh `verdicts.<round>.json` and re-apply
   with the DIRECTORY form (`verify --apply <masterDir> --run <masterDir>`),
   which reassembles every round's verdict files in one call. Stop when a round
   surfaces nothing new.

8. **Render & present** — `render --run <masterDir>` → `index.html` (per-claim
   verdict badges, a contradictions panel, the sub-question tree) + the
   consolidated `index.md`. Present the SUMMARY, the master folder, the verdict
   summary, and any contradictions.

## Fan-out subagent contract

A subagent runs in its **own context** — it sees none of this conversation, has
its own cwd, and no notion of a "repo root" or of where this skill lives. The
parent MUST substitute the **absolute path** to this skill's
`scripts/ultrasearch.mjs` into the prompt (and hand `plan` an absolute
`--run-root` so every `out` dir is absolute too). The parent already knows every
sub-run dir from `plan --run-root`, so it never has to read a subagent's output
to find the dossier. Dispatch one subagent per sub-question with a prompt shaped
like (`<skill-dir>` = this skill's absolute directory, resolved by the parent):

> You are gathering web evidence for ONE sub-question of a larger research run.
> Run (add `--lang <code> --region <cc>` and translate the `--queries` into that
> language when the run targets a non-English audience):
> `node <skill-dir>/scripts/ultrasearch.mjs gather --q "<sub-question>" --queries "<q1|q2|q3>" --mode <m> --depth deep --cache --out "<its out dir>"`
> Then open `<its out dir>/DOSSIER.md`. If it is flagged **thin** (or an angle is
> missing), enrich with your own WebSearch and, for each good URL,
> `node <skill-dir>/scripts/ultrasearch.mjs fetch --url "<url>" --out "<its out dir>"`.
> Do NOT write any report tier. Reply with exactly: the `out` dir, a one-line
> coverage note, and any NEW sub-questions you discovered (or "none").

The parent collects the `out` dirs (it assigned them), `merge`s them, and writes
the tiers against the master. New sub-questions a subagent surfaced feed the next
round (step 7). Sequential fallback: run the same `gather` calls in a loop — the
artifacts are identical.

## Parallel verification

`verify --shards <N> --shard <i>` writes a disjoint, deterministic slice of the
worklist to `VERIFY.todo.<i>.json` (round-robin over the canonical trust order,
so the shards are balanced and cover every pair exactly once). Give one shard to
each skeptic subagent:

> Adjudicate the claim↔source pairs in `<masterDir>/VERIFY.todo.<i>.json`. For
> each, open the cited `sources/S#.md` and set `verdict` to supported · partial ·
> unsupported · refuted (+ a short `note`). Default to the harsher verdict when
> unsure. If the pair lists `numeralsAbsent` (a figure/date the claim asserts
> that isn't in the extract), cap that verdict at `partial` — never `supported`.
> Save as `<masterDir>/verdicts.<i>.json` and reply with the path.

Then reassemble and gate in one call:
`verify --apply <masterDir> --run <masterDir>` (a directory picks up every
`*verdict*.json` in it), followed by `check --semantic --run <masterDir>`. A
contradiction that spans two shards (S1 supports in shard 0, S2 refutes in
shard 1) is detected only after this merge — which is exactly when it runs.

## Signals to act on

The engine surfaces three deterministic signals; react to each:

- **Thin dossier** — a `recallFloor` note + a `DOSSIER.md` banner when too few
  on-topic sources were kept. Enrich (`fetch --url`) before writing. Enforce it
  on a high-stakes run with `check --min-sources <n>`.
- **Snippet-only source** — marked `⚠ snippet only` in `DOSSIER.md`/HTML when the
  page fetch failed and only the search snippet is on file. Don't lean on it;
  re-`fetch` it or find a primary source before citing.
- **Contradiction** — claims whose cited sources disagree, listed by
  `check --semantic` and panelled in the HTML. Resolve in the report (pick the
  better-supported side, or document the dispute in "Open questions /
  contradictions") rather than silently citing one side.

## Mapping to a harness workflow

If your harness has a workflow/orchestration primitive, the shape is a
`pipeline` over the sub-questions (each item: gather → enrich) feeding a `merge`,
then a `parallel` fan-out of the verify shards into the reassembling `--apply`.
The CLI calls are identical; the primitive only schedules them.

## Budget

`DEEP_CAPS` bounds the loop so it can't run away: `maxSubQuestions` 6,
`maxRounds` 3, `maxVerify` 40, `perSubQuestionSources` 60. Tune per run with
`--max-subquestions` and `--max-verify`. Each sub-question fan-out is itself a
`--depth deep` gather, so retrieval depth and orchestration depth compose.
