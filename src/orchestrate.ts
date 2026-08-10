import { join } from "node:path";
import {
  listPhases as engineListPhases,
  orchestrateRun as engineOrchestrateRun,
  type OrchestrateOptions as EngineOrchestrateOptions,
  type OrchestrateResult as EngineOrchestrateResult,
  type PhaseDefinition,
  shq,
} from "./engine.js";
import { agentContracts, GATHER_SCHEMA, runbookPreamble, VERIFY_SCHEMA } from "./orchestrate-templates.js";
import type { ClaimEvidencePair, PlanResult } from "./types.js";

// ---------------------------------------------------------------------------
// `ultrasearch orchestrate` — the run's two phases, declared.
//
// The MACHINERY moved into the engine with webindex v1.15.0: resolving a
// worklist, batching it, emitting the Workflow script and the runbook, and
// asserting the two constraints that harness imposes (a pure-literal `meta`,
// and no Date.now/Math.random/new Date anywhere in the emitted file). That was
// the same ~480 lines in eight skills, and the copies had already drifted —
// one wrote its artifacts with a bare writeFileSync and escaped its own
// no-write gate.
//
// What is left here is what was always ultrasearch's: WHICH phases exist, what
// their worklists are called, how to read an id out of one, and what the
// orchestrator runs to fold the fragments back in. The engine never learns what
// a sub-question or a claim↔source pair is.
//
// The phase table and the emission spec used to live in two files (here and
// orchestrate-templates.ts). They are one declaration now, because the engine's
// PhaseDefinition is exactly their union — and keeping them apart is how the
// two came to disagree about which constant fed the batcher.
// ---------------------------------------------------------------------------

export const PHASES = ["gather", "verify"] as const;
export type PhaseName = (typeof PHASES)[number];

/**
 * The gather fold: union the sub-dossiers into the run dir itself (the master),
 * with the REAL out dirs from the plan.
 *
 * Reads `phase.parsed` — the engine hands the worklist back exactly so a fold
 * hint can name real paths instead of a placeholder.
 */
function mergeHint(runAbs: string, engineAbs: string, plan: PlanResult | undefined): string[] {
  const outs = plan ? plan.subQuestions.map((s) => s.out ?? join(runAbs, s.id.toLowerCase())) : [`${join(runAbs, "q1")},…`];
  const q = plan ? plan.question : "<question>";
  const mode = plan ? plan.mode : "<mode>";
  return [
    `node ${shq(engineAbs)} merge --runs ${shq(outs.join(","))} --master ${shq(runAbs)} --q ${shq(q)} --mode ${mode}`,
    `then write SUMMARY.md/REPORT.md against the MASTER [S#] ids, and feed any NEW sub-questions into the next round.`,
  ];
}

/** One gatherer per sub-question of PLAN.json — the deep-research playbook's fan-out. */
const GATHER: PhaseDefinition<PlanResult> = {
  name: "gather",
  worklist: "PLAN.json",
  ids: (plan) => (Array.isArray(plan?.subQuestions) ? plan.subQuestions.map((s) => s.id) : undefined),
  // Carry the persisted depth when there is one, so re-running the prerequisite
  // regenerates the SAME plan instead of silently dropping the field.
  prerequisite: (run, engineAbs, plan) =>
    plan
      ? `node ${shq(engineAbs)} plan --q ${shq(plan.question)} --mode ${plan.mode}${plan.depth ? ` --depth ${plan.depth}` : ""} --run-root ${shq(run)}`
      : `node ${shq(engineAbs)} plan --q "<question>" --mode <m> --run-root ${shq(run)}`,
  role: "gatherer",
  title: "Gather",
  schema: GATHER_SCHEMA,
  batchSize: 1,
  // Heavy units — a full sub-question gather each — so fan out at any count ≥ 2
  // and collapse only a single-item worklist.
  collapseFloor: () => 1,
  description: (n) =>
    `Gather web evidence for the ${n} sub-question(s) of an ultrasearch run (one gatherer per sub-question; the dossier union stays with the orchestrator)`,
  applyHint: (run, engineAbs, phase) => mergeHint(run, engineAbs, phase.parsed as PlanResult | undefined),
};

/** Skeptic fan-out over VERIFY.todo.json's claim↔source pairs. */
const VERIFY: PhaseDefinition<{ pairs?: ClaimEvidencePair[] }> = {
  name: "verify",
  worklist: "VERIFY.todo.json",
  ids: (todo) => (Array.isArray(todo?.pairs) ? todo.pairs.map((p) => `${p.claimId}:${p.sourceId}`) : undefined),
  prerequisite: (run, engineAbs) => `node ${shq(engineAbs)} verify --run ${shq(run)}`,
  role: "skeptic",
  title: "Verify",
  schema: VERIFY_SCHEMA,
  batchSize: 8,
  // Cheap per-pair judgments: a worklist at or under the shared floor does not
  // amortize a fan-out.
  collapseFloor: (small) => small,
  description: (n) => `Adversarially verify the ${n} claim↔source pair(s) of an ultrasearch report (skeptic fan-out, fail-closed fold)`,
  applyHint: (run, engineAbs) => [
    `round 2+: delete or archive the previous round's verdicts*.json FIRST — re-running verify renumbers claim ids,`,
    `and the directory fold below picks up EVERY verdicts*.json (a stale fragment corrupts the fold last-wins). Then:`,
    `save each returned fragment as ${join(run, "verdicts.<i>.json")} then reassemble + gate:`,
    `node ${shq(engineAbs)} verify --apply ${shq(run)} --run ${shq(run)}   # a dir picks up every verdicts*.json`,
  ],
};

/**
 * This run's phases, in order.
 *
 * Passed explicitly to the engine's `listPhases` / `orchestrateRun` rather than
 * bound behind a local wrapper: a wrapper would be a declaration shadowing an
 * engine export, which is the exact thing the usage gate refuses.
 */
// biome-ignore lint/suspicious/noExplicitAny: two differently-typed worklists in one table, which is the real shape
export const PHASE_DEFS = [GATHER, VERIFY] as any as PhaseDefinition<unknown>[];

// The runner, the resolver and their types are the engine's. Re-exported so
// every existing `from "./orchestrate.js"` keeps resolving.
export { BATCH_SIZE, listPhases, orchestrateRun, SMALL_WORKLIST, type OrchestrateOptions, type OrchestrateResult, type PhaseInfo } from "./engine.js";

/**
 * Emit this run's orchestration.
 *
 * A binder, not a fork: it supplies the three things that are ultrasearch's —
 * the phase table, the dispatch contracts, and the sequential runbook prose —
 * and hands them to the engine's runner. Named for what it does rather than
 * shadowing `orchestrateRun`, which the usage gate would refuse and which would
 * make it impossible to tell at a call site whose implementation was running.
 */
export function emitOrchestration(runDir: string, engineAbs: string, opts: EngineOrchestrateOptions = {}): EngineOrchestrateResult {
  return engineOrchestrateRun(runDir, engineAbs, PHASE_DEFS, agentContracts, {
    ...opts,
    runbookPreamble: runbookPreamble(listPhasesFor(runDir, engineAbs), runDir, engineAbs),
  });
}

/** This run's phases, resolved. The engine needs the table; every caller here has the same one. */
export function listPhasesFor(runDir: string, engineAbs: string) {
  return engineListPhases(runDir, engineAbs, PHASE_DEFS);
}
