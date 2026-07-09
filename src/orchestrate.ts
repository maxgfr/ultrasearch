import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { agentContracts, phaseWorkflowScript, runbookMd } from "./orchestrate-templates.js";
import type { ClaimEvidencePair, PlanResult } from "./types.js";
import { shq } from "./util.js";

// ---------------------------------------------------------------------------
// `ultrasearch orchestrate` — emit the run's multi-agent orchestration from its
// CURRENT worklists (per-phase workflow scripts + dispatch contracts + a
// sequential RUNBOOK), so a subagent-capable harness fans the research work
// out while the main agent stays the sole writer. Two phases:
//   gather — one gatherer per sub-question of PLAN.json (`plan --run-root`),
//            each writing ONLY its own sub-dossier; the orchestrator merges.
//   verify — skeptic fan-out over VERIFY.todo.json's claim↔source pairs;
//            the orchestrator folds the verdicts (`verify --apply`).
// Per-phase emission is deliberate: each worklist only exists after its engine
// step, so a whole-pipeline script could only carry placeholders — exactly
// what the check/verify gates exist to prevent. This makes the fan-out the
// deep-research playbook describes an EMITTED artifact, and extends the same
// machinery to standard-depth runs (plan small, fan out, merge, verify).
// ---------------------------------------------------------------------------

export const PHASES = ["gather", "verify"] as const;
export type PhaseName = (typeof PHASES)[number];

/** Small worklists don't amortize a fan-out — orchestrate says so and nudges --eco. */
export const SMALL_WORKLIST = 3;
/** One skeptic per batch of at most this many verify pairs (gather fans out 1 sub-question per agent). */
export const BATCH_SIZE = 8;

export interface PhaseInfo {
  name: PhaseName;
  ready: boolean;
  /** Absolute path of the worklist this phase fans out over. */
  worklist: string;
  items: number;
  /** The injected fan-out ids (sub-question Q# for gather, `claimId:sourceId` for verify). */
  ids: string[];
  /** The engine command that produces the worklist when it is missing. */
  prerequisite: string;
  /** gather only: the persisted plan (question/mode/depth + per-sub-question out dirs), present when ready. */
  plan?: PlanResult;
}

export function listPhases(runDir: string, engineAbs: string): PhaseInfo[] {
  const run = resolve(runDir);

  const planPath = join(run, "PLAN.json");
  let plan: PlanResult | undefined;
  if (existsSync(planPath)) {
    try {
      const f = JSON.parse(readFileSync(planPath, "utf8")) as PlanResult;
      if (f && Array.isArray(f.subQuestions)) plan = f;
    } catch {
      /* unreadable worklist = not ready */
    }
  }
  const planIds = plan ? plan.subQuestions.map((s) => s.id) : [];

  const verPath = join(run, "VERIFY.todo.json");
  let verIds: string[] = [];
  let verReady = false;
  if (existsSync(verPath)) {
    try {
      const f = JSON.parse(readFileSync(verPath, "utf8")) as { pairs?: ClaimEvidencePair[] };
      if (f && Array.isArray(f.pairs)) {
        verReady = true;
        verIds = f.pairs.map((p) => `${p.claimId}:${p.sourceId}`);
      }
    } catch {
      /* unreadable worklist = not ready */
    }
  }

  return [
    {
      name: "gather",
      ready: plan !== undefined,
      worklist: planPath,
      items: planIds.length,
      ids: planIds,
      ...(plan ? { plan } : {}),
      prerequisite: plan
        ? `node ${shq(engineAbs)} plan --q ${shq(plan.question)} --mode ${plan.mode} --run-root ${shq(run)}`
        : `node ${shq(engineAbs)} plan --q "<question>" --mode <m> --run-root ${shq(run)}`,
    },
    {
      name: "verify",
      ready: verReady,
      worklist: verPath,
      items: verIds.length,
      ids: verIds,
      prerequisite: `node ${shq(engineAbs)} verify --run ${shq(run)}`,
    },
  ];
}

export interface OrchestrateOptions {
  /** Emit only this phase (exit 2 if its worklist does not exist yet). */
  phase?: string;
  /** Emit only the RUNBOOK + contracts (the explicit low-token sequential path). */
  eco?: boolean;
}

export interface OrchestrateResult {
  exitCode: number;
  written: string[];
  notices: string[];
  errors: string[];
  phases: PhaseInfo[];
}

export function orchestrateRun(runDir: string, engineAbs: string, opts: OrchestrateOptions = {}): OrchestrateResult {
  const run = resolve(runDir);
  if (!existsSync(run)) {
    return { exitCode: 2, written: [], notices: [], errors: [`run dir not found: ${run}`], phases: [] };
  }
  const phases = listPhases(run, engineAbs);

  let selected = phases.filter((p) => p.ready);
  if (opts.phase !== undefined) {
    const ph = phases.find((p) => p.name === opts.phase);
    if (!ph) {
      return {
        exitCode: 2,
        written: [],
        notices: [],
        errors: [`unknown phase "${opts.phase}" — expected one of: ${PHASES.join(", ")}.`],
        phases,
      };
    }
    if (!ph.ready) {
      return {
        exitCode: 2,
        written: [],
        notices: [],
        errors: [`phase "${ph.name}" is not ready — its worklist ${ph.worklist} does not exist yet. Produce it first: ${ph.prerequisite}`],
        phases,
      };
    }
    selected = [ph];
  }

  const orchDir = join(run, "orchestration");
  const agentsDir = join(orchDir, "agents");
  mkdirSync(join(orchDir, "out"), { recursive: true });
  mkdirSync(agentsDir, { recursive: true });

  const written: string[] = [];
  const notices: string[] = [];

  // Contracts: every role, every call (idempotent overwrite) — they double as the
  // RUNBOOK's self-pass checklists, so eco mode needs them too.
  for (const [name, content] of Object.entries(agentContracts(run, engineAbs))) {
    const p = join(agentsDir, `${name}.md`);
    writeFileSync(p, content);
    written.push(p);
  }

  if (!opts.eco) {
    for (const ph of selected) {
      if (ph.items === 0) {
        notices.push(`phase "${ph.name}": worklist is empty — nothing to orchestrate.`);
        continue;
      }
      if (ph.items <= SMALL_WORKLIST) {
        notices.push(`phase "${ph.name}": only ${ph.items} item(s) — the sequential --eco path is equivalent and cheaper.`);
      }
      const p = join(orchDir, `${ph.name}.workflow.mjs`);
      writeFileSync(p, phaseWorkflowScript(ph, run, engineAbs, SMALL_WORKLIST));
      written.push(p);
    }
  }

  const rb = join(orchDir, "RUNBOOK.md");
  writeFileSync(rb, runbookMd(phases, run, engineAbs));
  written.push(rb);

  return { exitCode: 0, written, notices, errors: [], phases };
}
