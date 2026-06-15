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

## Portability contract

Every step is a plain `node scripts/ultrasearch.mjs …` call. Parallel subagents
are an **optimization, not a requirement**:

- **Harness with subagents** (e.g. Claude Code): dispatch one subagent per
  sub-question for the fan-out, and skeptic subagents for verification.
- **No subagents**: run the same commands in a sequential loop. Identical
  artifacts; only wall-clock differs.

Write the orchestration so it degrades gracefully — never make a step depend on a
specific runtime.

## The loop

1. **Decompose** — `plan --q "<question>" --mode <m>` → sub-questions (JSON).
   Facets come from the mode template, distinctive keywords, and any identifiers
   in the question. Override with `--subquestions "a|b|c"` when you can do better.
   Bounded by `DEEP_CAPS.maxSubQuestions` (6).

2. **Fan out** — one `gather --depth deep --out <runN>` per sub-question, passing
   that sub-question's `queries`. Enrich each thin area with your own WebSearch +
   `fetch` (the standard "bridge"). Parallel when possible, sequential otherwise.

3. **Merge** — `merge --runs "<run1,run2,…>" --master <masterDir>`. Re-fuses the
   combined pool by identity (DOI/arXiv/URL collapses cross-sub-question
   duplicates), drops near-duplicate content, records which sub-question(s)
   surfaced each source (provenance), and re-assigns **stable `S#` ids by fused
   rank**. Deterministic given the same inputs.

   > **Cite only the MASTER ids.** Sub-run dossiers all start at `S1`, so their
   > ids collide and are meaningless after merge. Write the report against the
   > master `DOSSIER.md` only.

4. **Write** the tiers (SUMMARY/REPORT/FULL) against the master dossier — same
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

   Fill each `verdict` (+ a short `note`) and save as `verdicts.json`. Capped at
   `DEEP_CAPS.maxVerify` (40) pairs, highest-trust sources first.

6. **Gate** — `verify --apply verdicts.json --run <masterDir>` then
   `check --semantic --run <masterDir>`. A claim fails if its source **refutes**
   it, or if every cited source is **unsupported** (nothing backs it). Fix the
   claim (re-cite, weaken, drop, or `fetch` a better source) and re-verify until
   the gate passes. `check --semantic` is the unified exit gate: mechanical
   grounding **and** semantic support.

7. **Loop until dry** — inspect the master dossier + report for residual gaps,
   contradictions, or new sub-questions a round surfaced. If any appear and you
   are under the round budget (`DEEP_CAPS.maxRounds`, 3), fan out the new
   sub-questions, `merge` them into the **same** master, and re-verify only the
   new claims. Stop when a round surfaces nothing new.

8. **Render & present** — `render --run <masterDir>` → `index.html` with per-claim
   verdict badges and the sub-question tree. Present the SUMMARY, the master
   folder, the verdict summary, and any contradictions.

## Budget

`DEEP_CAPS` bounds the loop so it can't run away: `maxSubQuestions` 6,
`maxRounds` 3, `maxVerify` 40, `perSubQuestionSources` 60. Tune per run with
`--max-subquestions` and `--max-verify`. Each sub-question fan-out is itself a
`--depth deep` gather, so retrieval depth and orchestration depth compose.
