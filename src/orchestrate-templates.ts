import { join } from "node:path";
import { oneWriterFooter, type PhaseInfo, shq } from "./engine.js";
import type { PlanResult } from "./types.js";

// ---------------------------------------------------------------------------
// Templates for `ultrasearch orchestrate` — the generator that turns the run's
// CURRENT worklists (PLAN.json, VERIFY.todo.json) into a launchable multi-agent
// Workflow per phase, the dispatch contracts it references, and a sequential
// RUNBOOK fallback. Everything here is emitted by string concatenation with the
// run's constants injected as JSON literals, so the workflow runs as-is under
// the Workflow tool: `export const meta` stays a pure literal, and no emitted
// line ever calls Date.now()/Math.random()/new Date() (they throw in that
// harness). The contracts reuse the deep-research playbook's wording — the
// engine now emits what references/deep-research-playbook.md describes.
// ---------------------------------------------------------------------------

/**
 * Family-standard footer: subagents return fragments; the orchestrator is the
 * sole writer. The skeptic gets it verbatim; the gatherer gets the ONE
 * sanctioned exception (below) — its own disjoint sub-dossier.
 */
const ONE_WRITER_FOOTER = `
## Return, don't write

Return ONLY the structured output specified above. Do NOT write, edit, or delete any file; do NOT run any engine command that writes (\`gather\`, \`fetch\`, \`merge\`, \`verify\`, \`render\`). The orchestrator is the sole writer — it saves your verdict fragments as \`verdicts.<i>.json\` itself and runs the fail-closed fold (\`verify --apply\`). Exception: if a note is prose too large to return, write ONLY to \`<RUN>/orchestration/out/<role>-<batch>.md\` (a file namespaced to you alone) and return its path.
`;

/**
 * The gatherer's variant: the fan-out contract in the deep-research playbook
 * has each gatherer write its OWN sub-dossier (`gather --out <its dir>` +
 * `fetch --out <its dir>`), disjoint from every other gatherer's by
 * construction — that write is sanctioned; everything else stays with the
 * orchestrator.
 */
const GATHERER_FOOTER = `
## Return, don't write (one sanctioned exception)

Return the structured output specified above. Your ONLY sanctioned writes are \`gather --out\` / \`fetch --out\` into YOUR OWN sub-dossier dir(s) — the \`out\` dir of each of your ITEMS, disjoint from every other gatherer's by construction. NEVER touch the parent run dir, the master dossier, any report tier (SUMMARY.md/REPORT.md), PLAN.json, or another sub-question's dir. The orchestrator is the sole writer everywhere else — it runs the \`merge\` fold itself. Exception: if a coverage note is prose too large to return, write ONLY to \`<RUN>/orchestration/out/gatherer-<batch>.md\` (a file namespaced to you alone) and return its path.
`;

// Structured-output schemas the emitted workflows pass to agent(..., { schema }).
// The gatherer's mirrors the playbook's return contract (out dir + one-line
// coverage note + NEW sub-questions); the skeptic's mirrors the verdict rows
// `verify --apply` folds, so a fragment that validates here still gets
// re-checked (verdict enum, fail-closed reduce) at fold time.
export const GATHER_SCHEMA = {
  type: "object",
  required: ["gathered"],
  properties: {
    gathered: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "out", "coverage", "newSubQuestions"],
        properties: {
          id: { type: "string", description: "the sub-question id (Q#)" },
          out: { type: "string", description: "the sub-dossier dir you gathered into (absolute)" },
          coverage: { type: "string", description: "one-line coverage note" },
          newSubQuestions: { type: "array", items: { type: "string" }, description: "NEW sub-questions you discovered (empty array for none)" },
        },
      },
    },
  },
};

export const VERIFY_SCHEMA = {
  type: "object",
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        required: ["claimId", "sourceId", "verdict", "note"],
        properties: {
          claimId: { type: "string" },
          sourceId: { type: "string" },
          verdict: { enum: ["supported", "partial", "unsupported", "refuted"] },
          note: { type: "string", description: "one line grounded in the cited extract" },
        },
      },
    },
  },
};

export function agentContracts(runAbs: string, engineAbs: string): Record<string, string> {
  const gathererFooter = GATHERER_FOOTER.replaceAll("<RUN>", runAbs);
  const skepticFooter = ONE_WRITER_FOOTER.replaceAll("<RUN>", runAbs);
  return {
    gatherer: `# Contract: gatherer

You are gathering web evidence for ONE (or a few) sub-question(s) of a larger ultrasearch research run. Handle ONLY the sub-questions whose \`id\` (Q#) is named in your prompt (\`ITEMS=<Q#,…>\`).

Worklist: \`${join(runAbs, "PLAN.json")}\` (\`subQuestions[]\`; each entry has \`id\`, \`question\`, \`queries\`, \`out\`; the plan also carries the run's \`mode\` and \`depth\`).

**Stale-id guard:** if an ITEMS id is no longer in the worklist, or its \`Q#\` entry's question text doesn't match the sub-question you were dispatched for, STOP and report the mismatch instead of gathering — a re-plan renumbers ids, and gathering under a stale id would fill the wrong sub-dossier.

For EACH of your sub-questions:

1. **Sweep with your OWN WebSearch first — this is the primary engine, not an extra.**
   \`node ${engineAbs} queries --q "<its question>" --mode <the plan's mode> --depth <the plan's depth>\`
   names how many DISTINCT queries to run and which angles to cover. Run your WebSearch once per angle, pool EVERY hit into \`<its out dir>/websearch.json\` as \`[{"url":…,"title":…,"snippet":…}, …]\`. A fan-out multiplies whatever discovery it was given, so a sub-question gathered with no lane is where this run quietly gets worse.
2. Run (add \`--lang <code> --region <cc>\` and translate BOTH the \`--queries\` and your WebSearch queries into that language when the run targets a non-English audience):
   \`node ${engineAbs} gather --q "<its question>" --queries "<its queries, |-joined>" --mode <the plan's mode> --depth <the plan's depth; deep when the plan predates the field> --web-results "<its out dir>/websearch.json" --out "<its out dir>"\`
   (The on-disk fetch cache is ON by default and shared across processes, so a URL two sub-questions both surface is fetched once. Do NOT pass \`--no-cache\` here.)
3. Open \`<its out dir>/DOSSIER.md\`. If it is flagged **thin**, or it lists **under-covered** terms, or an angle is missing, run a SECOND WebSearch round at that gap and fold the whole round in with ONE call:
   \`node ${engineAbs} ingest --run "<its out dir>" --web-results "<round2.json>"\`
   Pin URLs a reader can OPEN — landing pages, never raw API endpoints or batch/search URLs (the engine rewrites the endpoints it knows and refuses the rest). If it answers that a page "extracted to a … wall", the host is throttling you: that is a refusal, not a setback to work around — take another source, or pass the provider's text endpoint and let the engine record the page.
4. Do NOT write any report tier.

Return (structured output): \`{ "gathered": [{ "id", "out", "coverage", "newSubQuestions" }] }\` — for each of your ITEMS: its \`out\` dir, a one-line coverage note, and any NEW sub-questions you discovered (an empty array for none).
${gathererFooter}`,
    skeptic: `# Contract: skeptic

You are an adversarial skeptic verifying the claims of an ultrasearch report against their cited sources. Try to REFUTE each claim: assume it is wrong until the source proves it.

Worklist: \`${join(runAbs, "VERIFY.todo.json")}\` (an object with \`pairs[]\`; each entry has \`claimId\`, \`sourceId\`, \`claim\`, \`extractPath\`, \`extractDigest\`, and sometimes \`numeralsAbsent\`). Handle ONLY the pairs whose \`claimId:sourceId\` key is named in your prompt (\`ITEMS=<C#:S#,…>\`).

**Stale-id guard:** if an ITEMS key is no longer in the worklist, STOP and report the mismatch instead of adjudicating — a regenerated worklist renumbers claim ids, and a verdict filed under a stale id would adjudicate the wrong claim.

For EACH of your pairs:

1. Open the cited source's full extract at \`${runAbs}/<extractPath>\` (the \`extractDigest\` in the worklist is only a claim-focused preview) and read the relevant passage in context.
2. Judge whether the source actually SUPPORTS the claim:
   - \`supported\` — the source states the claim.
   - \`partial\` — it supports part / a weaker version.
   - \`unsupported\` — it doesn't address the claim.
   - \`refuted\` — it contradicts the claim.
   When unsure, choose the HARSHER verdict — a false pass is worse than a false fail.
3. **Numeral rule:** if the pair lists \`numeralsAbsent\` (a figure/date/quantity the claim asserts that is not in the cited extract), the verdict caps at \`partial\` — never \`supported\` — unless you locate the figure in the full extract.
4. \`note\` is REQUIRED — one line grounded in what you read (quote or paraphrase the decisive passage).

Return (structured output): \`{ "verdicts": [{ "claimId", "sourceId", "verdict", "note" }] }\` — your ITEMS only.
${skepticFooter}`,
  };
}

// ---------------------------------------------------------------------------
// ultrasearch's OWN runbook prose.
//
// Not deduplicated, and it should not be: the seven steps below are this
// tool's pipeline — plan, gather, merge, write the tiers, verify, gate, loop
// until dry — not shared machinery. The engine's runbookMd is the generic
// fallback for a skill that has no document of its own; this one is handed to
// it as the preamble, and the engine appends its per-phase listing underneath.
// ---------------------------------------------------------------------------
export function runbookPreamble(phases: PhaseInfo[], runAbs: string, engineAbs: string): string[] {
  // A markdown table cell must stay one line with its pipes escaped — the
  // prerequisite embeds the (shell-quoted) free-text question.
  const cell = (s: string) => s.replace(/\r?\n/g, " ").replaceAll("|", "\\|");
  const status = phases
    .map((p) => `| ${p.name} | \`${cell(p.worklist)}\` | ${p.ready ? `ready (${p.items} item(s))` : "not ready"} | \`${cell(p.prerequisite)}\` |`)
    .join("\n");
  const engine = `node ${shq(engineAbs)}`;
  const gather = phases.find((p) => p.name === "gather");
  // `parsed` is the engine's generic name for the worklist a ready phase read.
  const gatherPlan = gather?.parsed as PlanResult | undefined;
  const outs = gatherPlan ? shq(gatherPlan.subQuestions.map((s) => s.out ?? join(runAbs, s.id.toLowerCase())).join(",")) : '"<the out dirs, comma-joined>"';
  const q = gatherPlan ? shq(gatherPlan.question) : '"<question>"';
  const mode = gatherPlan ? gatherPlan.mode : "<m>";
  const run = shq(runAbs);
  // No H1 and no `Run:` line: the engine's runbookMd emits both above this,
  // and two titles in one document is how a reader loses track of which one
  // they are in.
  return [
    `Engine: \`${engine}\`

Generated by \`ultrasearch orchestrate\` from the CURRENT run state. This sequential path is
correctness-identical to the multi-agent workflows — same worklists, same contracts, same
fail-closed gates; only wall-clock differs.
Parallel subagents are an optimization, never a requirement.

## Phase status

| Phase | Worklist | Status | Produce it with |
|---|---|---|---|
${status}

## The loop (play every role yourself, one item at a time)

1. **Plan** (if not done): \`${engine} plan --q "<question>" --mode <m> --run-root ${run}\` → \`${join(runAbs, "PLAN.json")}\` (standard tier: keep it small with \`--max-subquestions 3\` and pass \`--depth standard\`; deep tier: add \`--depth deep\`; without \`--depth\` the fan-out gathers deep).
2. **Gather per sub-question** — for EVERY entry in \`${join(runAbs, "PLAN.json")}\`, apply \`${join(runAbs, "orchestration", "agents", "gatherer.md")}\` yourself: sweep with your own WebSearch into \`<its out dir>/websearch.json\`, run its \`gather --q … --queries … --web-results … --out <its out dir>\`, then top up a thin or under-covered sub-dossier with a second round (\`ingest --run <its out dir> --web-results <round2.json>\`).
3. **Merge** — \`${engine} merge --runs ${outs} --master ${run} --q ${q} --mode ${mode}\`. Cite only the MASTER \`[S#]\` ids from here.
4. **Write the tiers** — SUMMARY.md + REPORT.md in \`${runAbs}\`, every claim cited \`[S#]\`, your own knowledge flagged \`[M]\`.
5. **Verify the claims** — \`${engine} verify --run ${run}\` writes \`${join(runAbs, "VERIFY.todo.json")}\`. For EVERY pair, apply \`${join(runAbs, "orchestration", "agents", "skeptic.md")}\` yourself (open the cited extract, verdict supported/partial/unsupported/refuted + note). Save your verdicts as \`${join(runAbs, "verdicts.json")}\`, then fold: \`${engine} verify --apply ${run} --run ${run}\`.
6. **Gate** — \`${engine} render --run ${run}\` and \`${engine} check --run ${run} --semantic\` must pass before presenting (deep tier: add \`--require-verify\`).
7. **Loop until dry** — NEW sub-questions from step 2 → fan out again, \`merge\` into the SAME master, re-verify. Before re-folding, delete or archive the previous round's \`verdicts*.json\`: re-running \`verify\` renumbers claim ids, and the \`--apply\` directory glob refolds every \`verdicts*.json\` (a stale round-1 file corrupts the gate last-wins). Stop when a round surfaces nothing new.

With subagents available, prefer the emitted workflows instead: \`orchestrate --run ${run} --phase <p>\` then \`Workflow({ scriptPath: "${join(runAbs, "orchestration", "<p>.workflow.mjs")}" })\` — you stay the sole writer either way.
`,
  ];
}
