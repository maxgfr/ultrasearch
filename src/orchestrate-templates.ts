import { join } from "node:path";
import type { PhaseInfo } from "./orchestrate.js";
import { shq } from "./util.js";

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
const GATHER_SCHEMA = {
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

const VERIFY_SCHEMA = {
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

interface PhaseSpec {
  role: string;
  title: string;
  schema: unknown;
  /** One agent per batch of at most this many worklist items (1 = one gatherer per sub-question). */
  batchSize: number;
  /**
   * Collapse the fan-out to a single batch (and nudge --eco) when the worklist
   * is at or under this floor. Per-phase because the units differ in weight:
   * a gather unit is a FULL sub-question gather (heavy — fan out at any count
   * ≥ 2, collapse only a single-item worklist), while a verify unit is one
   * cheap claim↔source judgment (a worklist ≤ smallWorklist doesn't amortize
   * a fan-out).
   */
  collapseFloor: (smallWorklist: number) => number;
  description: (items: number) => string;
  /** The orchestrator's fold step, shown as comment lines in the workflow tail + in the runbook. */
  applyHint: (engineAbs: string, ph: PhaseInfo, runAbs: string) => string[];
}

/** The gather fold: union the sub-dossiers into the run dir itself (the master), with the REAL out dirs from the plan. */
function mergeHint(engineAbs: string, ph: PhaseInfo, runAbs: string): string[] {
  const outs = ph.plan ? ph.plan.subQuestions.map((s) => s.out ?? join(runAbs, s.id.toLowerCase())) : [`${join(runAbs, "q1")},…`];
  const q = ph.plan ? ph.plan.question : "<question>";
  const mode = ph.plan ? ph.plan.mode : "<mode>";
  return [
    `node ${shq(engineAbs)} merge --runs ${shq(outs.join(","))} --master ${shq(runAbs)} --q ${shq(q)} --mode ${mode}`,
    `then write SUMMARY.md/REPORT.md against the MASTER [S#] ids, and feed any NEW sub-questions into the next round.`,
  ];
}

const PHASE_SPECS: Record<string, PhaseSpec> = {
  gather: {
    role: "gatherer",
    title: "Gather",
    schema: GATHER_SCHEMA,
    batchSize: 1, // one gatherer per sub-question — the playbook's fan-out
    collapseFloor: () => 1, // heavy units: fan out at any count ≥ 2
    description: (n) =>
      `Gather web evidence for the ${n} sub-question(s) of an ultrasearch run (one gatherer per sub-question; the dossier union stays with the orchestrator)`,
    applyHint: mergeHint,
  },
  verify: {
    role: "skeptic",
    title: "Verify",
    schema: VERIFY_SCHEMA,
    batchSize: 8, // BATCH_SIZE — one skeptic per batch of claim↔source pairs
    collapseFloor: (smallWorklist) => smallWorklist, // cheap per-pair judgments: ≤ SMALL_WORKLIST doesn't amortize
    description: (n) => `Adversarially verify the ${n} claim↔source pair(s) of an ultrasearch report (skeptic fan-out, fail-closed fold)`,
    applyHint: (engine, _ph, run) => [
      `save each returned fragment as ${join(run, "verdicts.<i>.json")} then reassemble + gate:`,
      `node ${shq(engine)} verify --apply ${shq(run)} --run ${shq(run)}   # a dir picks up every verdicts*.json`,
    ],
  },
};

export function phaseSpec(name: string): PhaseSpec {
  const spec = PHASE_SPECS[name];
  if (!spec) throw new Error(`no phase spec for "${name}"`);
  return spec;
}

/** Chunk worklist ids into batches, one subagent per batch (order-preserving, deterministic). */
export function toBatches(ids: string[], batchSize: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += batchSize) out.push(ids.slice(i, i + batchSize));
  return out;
}

export function phaseWorkflowScript(ph: PhaseInfo, runAbs: string, engineAbs: string, smallWorklist: number): string {
  const spec = phaseSpec(ph.name);
  const scriptPath = join(runAbs, "orchestration", `${ph.name}.workflow.mjs`);
  const meta = { name: `ultrasearch-${ph.name}`, description: spec.description(ph.items), phases: [{ title: spec.title }] };
  // A worklist at or under the phase's collapse floor doesn't amortize a
  // fan-out: collapse it to a single batch (one agent plays every item) — the
  // eco nudge fires too. The floor is per-phase (heavy gather units keep one
  // gatherer per sub-question at any count ≥ 2; cheap verify pairs collapse ≤ SMALL_WORKLIST).
  const batches = ph.items <= spec.collapseFloor(smallWorklist) ? [ph.ids] : toBatches(ph.ids, spec.batchSize);
  const hint = spec.applyHint(engineAbs, ph, runAbs);
  return [
    `export const meta = ${JSON.stringify(meta)}`,
    ``,
    `// NOT a plain Node script: launch via the Workflow tool — Workflow({ scriptPath: ${JSON.stringify(scriptPath)} }).`,
    `// Emitted by \`ultrasearch orchestrate\` from the CURRENT worklist. The worklist is the source`,
    `// of truth: if it changes, re-run \`orchestrate --phase ${ph.name}\` before launching.`,
    ``,
    `// Constants for THIS run (injected at emit time; no Date.now/Math.random in this harness).`,
    `const RUN = ${JSON.stringify(runAbs)}`,
    `const ENGINE = ${JSON.stringify(engineAbs)}`,
    `const WORKLIST = ${JSON.stringify(ph.worklist)}`,
    `const AGENTS = RUN + '/orchestration/agents'`,
    `const BATCHES = ${JSON.stringify(batches)}`,
    `const SCHEMA = ${JSON.stringify(spec.schema)}`,
    ``,
    `function contract(name, extra) {`,
    `  return 'Read and follow the dispatch contract at ' + AGENTS + '/' + name + '.md VERBATIM.\\n'`,
    `    + 'Constants: RUN=' + RUN + '  ENGINE=' + ENGINE + '  WORKLIST=' + WORKLIST + '.\\n'`,
    `    + 'Invoke the engine only by its ABSOLUTE path: node ' + ENGINE + ' <cmd> — stay within the contract write rules.'`,
    `    + (extra ? '\\n' + extra : '')`,
    `}`,
    ``,
    `log('ultrasearch ${ph.name}: ' + ${JSON.stringify(String(ph.items))} + ' item(s) across ' + BATCHES.length + ' agent(s)')`,
    ``,
    `phase(${JSON.stringify(spec.title)})`,
    `const results = await pipeline(BATCHES, (batch, _item, i) =>`,
    `  agent(contract('${spec.role}', 'ITEMS=' + batch.join(',')), { label: '${ph.name}:' + (i + 1), phase: ${JSON.stringify(spec.title)}, agentType: 'general-purpose', schema: SCHEMA }))`,
    ``,
    `// One-writer rule: this workflow only COLLECTS the subagents' fragments. The main agent`,
    `// runs the fold itself:`,
    ...hint.map((l) => `//   ${l}`),
    `return { phase: ${JSON.stringify(ph.name)}, worklist: WORKLIST, results: results.filter(Boolean) }`,
    ``,
  ].join("\n");
}

export function agentContracts(runAbs: string, engineAbs: string): Record<string, string> {
  const gathererFooter = GATHERER_FOOTER.replaceAll("<RUN>", runAbs);
  const skepticFooter = ONE_WRITER_FOOTER.replaceAll("<RUN>", runAbs);
  return {
    gatherer: `# Contract: gatherer

You are gathering web evidence for ONE (or a few) sub-question(s) of a larger ultrasearch research run. Handle ONLY the sub-questions whose \`id\` (Q#) is named in your prompt (\`ITEMS=<Q#,…>\`).

Worklist: \`${join(runAbs, "PLAN.json")}\` (\`subQuestions[]\`; each entry has \`id\`, \`question\`, \`queries\`, \`out\`; the plan also carries the run's \`mode\` and \`depth\`).

For EACH of your sub-questions:

1. Run (add \`--lang <code> --region <cc>\` and translate the \`--queries\` into that language when the run targets a non-English audience):
   \`node ${engineAbs} gather --q "<its question>" --queries "<its queries, |-joined>" --mode <the plan's mode> --depth <the plan's depth; deep when the plan predates the field> --cache --out "<its out dir>"\`
   (\`--cache\` shares the on-disk fetch cache across the fan-out, so overlapping URLs are fetched once.)
2. Open \`<its out dir>/DOSSIER.md\`. If it is flagged **thin** (or an angle is missing), enrich with your own WebSearch and, for each good URL:
   \`node ${engineAbs} fetch --url "<url>" --out "<its out dir>"\`
3. Do NOT write any report tier.

Return (structured output): \`{ "gathered": [{ "id", "out", "coverage", "newSubQuestions" }] }\` — for each of your ITEMS: its \`out\` dir, a one-line coverage note, and any NEW sub-questions you discovered (an empty array for none).
${gathererFooter}`,
    skeptic: `# Contract: skeptic

You are an adversarial skeptic verifying the claims of an ultrasearch report against their cited sources. Try to REFUTE each claim: assume it is wrong until the source proves it.

Worklist: \`${join(runAbs, "VERIFY.todo.json")}\` (an object with \`pairs[]\`; each entry has \`claimId\`, \`sourceId\`, \`claim\`, \`extractPath\`, \`extractDigest\`, and sometimes \`numeralsAbsent\`). Handle ONLY the pairs whose \`claimId:sourceId\` key is named in your prompt (\`ITEMS=<C#:S#,…>\`).

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

export function runbookMd(phases: PhaseInfo[], runAbs: string, engineAbs: string): string {
  // A markdown table cell must stay one line with its pipes escaped — the
  // prerequisite embeds the (shell-quoted) free-text question.
  const cell = (s: string) => s.replace(/\r?\n/g, " ").replaceAll("|", "\\|");
  const status = phases
    .map((p) => `| ${p.name} | \`${cell(p.worklist)}\` | ${p.ready ? `ready (${p.items} item(s))` : "not ready"} | \`${cell(p.prerequisite)}\` |`)
    .join("\n");
  const engine = `node ${shq(engineAbs)}`;
  const gather = phases.find((p) => p.name === "gather");
  const outs = gather?.plan ? shq(gather.plan.subQuestions.map((s) => s.out ?? join(runAbs, s.id.toLowerCase())).join(",")) : '"<the out dirs, comma-joined>"';
  const q = gather?.plan ? shq(gather.plan.question) : '"<question>"';
  const mode = gather?.plan ? gather.plan.mode : "<m>";
  const run = shq(runAbs);
  return `# ultrasearch — sequential RUNBOOK (eco / no-subagent fallback)

Run: \`${runAbs}\` · Engine: \`${engine}\`

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
2. **Gather per sub-question** — for EVERY entry in \`${join(runAbs, "PLAN.json")}\`, apply \`${join(runAbs, "orchestration", "agents", "gatherer.md")}\` yourself: run its \`gather --q … --queries … --cache --out <its out dir>\`, then enrich a thin sub-dossier (your WebSearch + \`fetch --url … --out <its out dir>\`).
3. **Merge** — \`${engine} merge --runs ${outs} --master ${run} --q ${q} --mode ${mode}\`. Cite only the MASTER \`[S#]\` ids from here.
4. **Write the tiers** — SUMMARY.md + REPORT.md in \`${runAbs}\`, every claim cited \`[S#]\`, your own knowledge flagged \`[M]\`.
5. **Verify the claims** — \`${engine} verify --run ${run}\` writes \`${join(runAbs, "VERIFY.todo.json")}\`. For EVERY pair, apply \`${join(runAbs, "orchestration", "agents", "skeptic.md")}\` yourself (open the cited extract, verdict supported/partial/unsupported/refuted + note). Save your verdicts as \`${join(runAbs, "verdicts.json")}\`, then fold: \`${engine} verify --apply ${run} --run ${run}\`.
6. **Gate** — \`${engine} render --run ${run}\` and \`${engine} check --run ${run} --semantic\` must pass before presenting (deep tier: add \`--require-verify\`).
7. **Loop until dry** — NEW sub-questions from step 2 → fan out again, \`merge\` into the SAME master, re-verify. Stop when a round surfaces nothing new.

With subagents available, prefer the emitted workflows instead: \`orchestrate --run ${run} --phase <p>\` then \`Workflow({ scriptPath: "${join(runAbs, "orchestration", "<p>.workflow.mjs")}" })\` — you stay the sole writer either way.
`;
}
