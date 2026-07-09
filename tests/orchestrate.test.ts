import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { BATCH_SIZE, SMALL_WORKLIST, listPhases, orchestrateRun } from "../src/orchestrate.js";
import { runPlan } from "../src/plan.js";
import type { PlanResult } from "../src/types.js";
import { runVerify } from "../src/verify.js";
import { writeFixtureDossier } from "./dossierfix.js";

const ENGINE = "/opt/skills/ultrasearch/scripts/ultrasearch.mjs";

/**
 * A run dir holding real engine-written worklists (the same writers the
 * pipeline uses — no hand-rolled shapes):
 *  - plan: `runPlan(..., runRoot)` → PLAN.json (the gather-phase worklist),
 *  - verify: fixture dossier + REPORT.md → `runVerify` → VERIFY.todo.json.
 * `verify: 0` produces a REPORT with no citations, so the REAL engine writes
 * an EMPTY worklist (pairs: []).
 */
function makeRun(opts: { plan?: number; verify?: number } = {}): string {
  const run = mkdtempSync(join(tmpdir(), "us-orch-"));
  if (opts.plan !== undefined) {
    const subs = Array.from({ length: opts.plan }, (_, i) => `how does rate limiting facet ${i + 1} behave under load`);
    runPlan("how does HTTP rate limiting work", "topic", subs, Math.max(1, opts.plan), run, "standard");
  }
  if (opts.verify !== undefined) {
    writeFixtureDossier(run, 1);
    const claims = Array.from({ length: opts.verify }, (_, i) => `- Rate limiting fact number ${"abcdefghijklmnopqrstuvwxyz"[i % 26]} holds. [S1]`);
    writeFileSync(join(run, "REPORT.md"), `# Report\n\n${claims.join("\n")}\n`);
    runVerify(run);
  }
  return run;
}

const wf = (run: string, phase: string) => join(run, "orchestration", `${phase}.workflow.mjs`);
const readWf = (run: string, phase: string) => readFileSync(wf(run, phase), "utf8");
const stable = (src: string, run: string) => src.replaceAll(run, "<RUN>").replaceAll(ENGINE, "<ENGINE>");

/** Drive main() in-process, capturing stdout/stderr and the process.exit code (cli-main.test.ts pattern). */
async function run(argv: string[]): Promise<{ out: string; err: string; exit?: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
    out.push(String(c));
    return true;
  }) as never);
  const e = vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => {
    err.push(String(c));
    return true;
  }) as never);
  const x = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  let exit: number | undefined;
  try {
    await main(argv);
  } catch (er) {
    const m = /^exit:(\d+)$/.exec((er as Error).message);
    if (!m) {
      o.mockRestore();
      e.mockRestore();
      x.mockRestore();
      throw er;
    }
    exit = Number(m[1]);
  }
  o.mockRestore();
  e.mockRestore();
  x.mockRestore();
  return { out: out.join(""), err: err.join(""), exit };
}

describe("orchestrate — listPhases", () => {
  it("reports both phases not ready on an empty run, naming the producing command", () => {
    const run = makeRun();
    const phases = listPhases(run, ENGINE);
    expect(phases.map((p) => p.name)).toEqual(["gather", "verify"]);
    for (const p of phases) {
      expect(p.ready).toBe(false);
      expect(p.items).toBe(0);
    }
    expect(phases[0]!.prerequisite).toContain("plan --q");
    expect(phases[0]!.prerequisite).toContain("--run-root");
    expect(phases[1]!.prerequisite).toContain(`verify --run`);
  });

  it("reports ready phases with real item counts and absolute worklist paths", () => {
    const run = makeRun({ plan: 5, verify: 2 });
    const phases = listPhases(run, ENGINE);
    expect(phases[0]).toMatchObject({ name: "gather", ready: true, items: 5 });
    expect(phases[0]!.ids).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5"]);
    expect(phases[1]).toMatchObject({ name: "verify", ready: true, items: 2 });
    expect(phases[1]!.ids).toEqual(["C1:S1", "C2:S1"]);
    for (const p of phases) expect(isAbsolute(p.worklist)).toBe(true);
  });

  it("a ready gather phase carries the persisted plan (question, mode, depth) and a concrete prerequisite", () => {
    const run = makeRun({ plan: 2 });
    const [gather] = listPhases(run, ENGINE);
    expect(gather!.plan).toBeDefined();
    expect(gather!.plan!.question).toBe("how does HTTP rate limiting work");
    expect(gather!.plan!.mode).toBe("topic");
    expect(gather!.plan!.depth).toBe("standard");
    expect(gather!.prerequisite).toContain("how does HTTP rate limiting work");
  });
});

describe("orchestrate — emitted workflow", () => {
  it("emits one workflow per ready phase, plus contracts and the runbook", () => {
    const run = makeRun({ plan: 5, verify: 2 });
    const res = orchestrateRun(run, ENGINE);
    expect(res.exitCode).toBe(0);
    expect(existsSync(wf(run, "gather"))).toBe(true);
    expect(existsSync(wf(run, "verify"))).toBe(true);
    expect(existsSync(join(run, "orchestration", "RUNBOOK.md"))).toBe(true);
    expect(existsSync(join(run, "orchestration", "agents", "gatherer.md"))).toBe(true);
    expect(existsSync(join(run, "orchestration", "agents", "skeptic.md"))).toBe(true);
    expect(existsSync(join(run, "orchestration", "out"))).toBe(true);
  });

  it("parses as JavaScript the way the Workflow harness evaluates it (meta export + async body)", () => {
    const run = makeRun({ plan: 5, verify: 2 });
    orchestrateRun(run, ENGINE);
    for (const phase of ["gather", "verify"]) {
      const [metaLine, ...body] = readWf(run, phase).split("\n");
      expect(() => new Script(metaLine!.replace("export const meta =", "const meta ="))).not.toThrow();
      expect(() => new Script(`(async () => {\n${body.join("\n")}\n})`)).not.toThrow();
    }
  });

  it("meta is a pure JSON literal on line 1 (name, description, phases)", () => {
    const run = makeRun({ plan: 5 });
    orchestrateRun(run, ENGINE);
    const first = readWf(run, "gather").split("\n")[0]!;
    expect(first.startsWith("export const meta = ")).toBe(true);
    const meta = JSON.parse(first.replace("export const meta = ", "")) as { name: string; description: string; phases: unknown[] };
    expect(meta.name).toBe("ultrasearch-gather");
    expect(meta.description.length).toBeGreaterThan(0);
    expect(Array.isArray(meta.phases)).toBe(true);
  });

  it("never contains Date.now / Math.random / new Date (forbidden under the Workflow tool)", () => {
    const run = makeRun({ plan: 5, verify: 2 });
    orchestrateRun(run, ENGINE);
    for (const phase of ["gather", "verify"]) {
      const src = readWf(run, phase);
      expect(src).not.toContain("Date.now(");
      expect(src).not.toContain("Math.random(");
      expect(src).not.toContain("new Date(");
    }
  });

  it("injects absolute RUN/ENGINE/WORKLIST constants matching the run", () => {
    const run = makeRun({ verify: 2 });
    orchestrateRun(run, ENGINE);
    const src = readWf(run, "verify");
    for (const name of ["RUN", "ENGINE", "WORKLIST"]) {
      const m = src.match(new RegExp(`const ${name} = "([^"]+)"`));
      expect(m, `const ${name} missing`).not.toBeNull();
      expect(isAbsolute(m![1]!)).toBe(true);
    }
    expect(src).toContain(JSON.stringify(join(run, "VERIFY.todo.json")));
    expect(src).toContain(JSON.stringify(ENGINE));
  });

  it("injects the REAL current worklist ids — a doctored worklist shows up on re-emit", () => {
    const run = makeRun({ plan: 4, verify: 4 });
    orchestrateRun(run, ENGINE);
    expect(readWf(run, "gather")).not.toContain("Q9");
    expect(readWf(run, "verify")).not.toContain("C99:S1");
    const planPath = join(run, "PLAN.json");
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as PlanResult;
    plan.subQuestions.push({ ...plan.subQuestions[0]!, id: "Q9", question: "a brand new angle" });
    writeFileSync(planPath, JSON.stringify(plan, null, 2));
    const todoPath = join(run, "VERIFY.todo.json");
    const todo = JSON.parse(readFileSync(todoPath, "utf8")) as { pairs: Record<string, unknown>[] };
    todo.pairs.push({ ...todo.pairs[0]!, claimId: "C99" });
    writeFileSync(todoPath, JSON.stringify(todo, null, 2));
    orchestrateRun(run, ENGINE);
    expect(readWf(run, "gather")).toContain("Q9");
    expect(readWf(run, "verify")).toContain("C99:S1");
  });

  it("is deterministic — two runs over the same state emit byte-identical artifacts", () => {
    const run = makeRun({ plan: 5, verify: 2 });
    orchestrateRun(run, ENGINE);
    const read = () =>
      ["gather", "verify"].map((p) => readWf(run, p)).join("\0") +
      readFileSync(join(run, "orchestration", "RUNBOOK.md"), "utf8") +
      readFileSync(join(run, "orchestration", "agents", "gatherer.md"), "utf8") +
      readFileSync(join(run, "orchestration", "agents", "skeptic.md"), "utf8");
    const first = read();
    orchestrateRun(run, ENGINE);
    expect(read()).toBe(first);
  });

  it("batches the verify worklist (one skeptic per batch of BATCH_SIZE pairs)", () => {
    const run = makeRun({ verify: 20 });
    orchestrateRun(run, ENGINE);
    const src = readWf(run, "verify");
    const m = src.match(/const BATCHES = (\[.*?\])\n/s);
    expect(m).not.toBeNull();
    const batches = JSON.parse(m![1]!) as string[][];
    expect(batches.length).toBe(Math.ceil(20 / BATCH_SIZE));
    expect(batches.flat().length).toBe(20);
    expect(src).toContain("pipeline(BATCHES");
    expect(src).toContain("agentType: 'general-purpose'");
    expect(src).toContain("schema: SCHEMA");
  });

  it("fans gather out one gatherer per sub-question (above the small-worklist floor)", () => {
    const run = makeRun({ plan: 5 });
    orchestrateRun(run, ENGINE);
    const src = readWf(run, "gather");
    const m = src.match(/const BATCHES = (\[.*?\])\n/s);
    const batches = JSON.parse(m![1]!) as string[][];
    expect(batches.length).toBe(5);
    for (const b of batches) expect(b.length).toBe(1);
    expect(batches.flat()).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5"]);
    expect(src).toContain("pipeline(BATCHES");
    expect(src).toContain("schema: SCHEMA");
  });

  // Gather units are HEAVY (a full sub-question gather each); verify units are
  // cheap per-pair judgments. The small-worklist collapse is therefore
  // per-phase: gather fans out at ANY count ≥ 2, verify collapses at ≤ SMALL_WORKLIST.
  it("gather at the standard-depth default (3 sub-questions) fans out 3 gatherers — no collapse, no eco nudge", () => {
    const run = makeRun({ plan: 3 });
    const res = orchestrateRun(run, ENGINE);
    const m = readWf(run, "gather").match(/const BATCHES = (\[.*?\])\n/s);
    const batches = JSON.parse(m![1]!) as string[][];
    expect(batches.length).toBe(3);
    for (const b of batches) expect(b.length).toBe(1);
    expect(batches.flat()).toEqual(["Q1", "Q2", "Q3"]);
    expect(res.notices.filter((n) => n.includes("gather") && n.includes("--eco")).length).toBe(0);
  });

  it("a single-sub-question gather collapses to one agent + the eco nudge", () => {
    const run = makeRun({ plan: 1 });
    const res = orchestrateRun(run, ENGINE);
    const m = readWf(run, "gather").match(/const BATCHES = (\[.*?\])\n/s);
    expect((JSON.parse(m![1]!) as string[][]).length).toBe(1);
    expect(res.notices.some((n) => n.includes("gather") && n.includes("--eco"))).toBe(true);
  });

  it("verify keeps the ≤ SMALL_WORKLIST collapse (single agent + eco nudge at 3 pairs)", () => {
    const run = makeRun({ verify: 3 });
    const res = orchestrateRun(run, ENGINE);
    const m = readWf(run, "verify").match(/const BATCHES = (\[.*?\])\n/s);
    expect((JSON.parse(m![1]!) as string[][]).length).toBe(1);
    expect(res.notices.some((n) => n.includes("verify") && n.includes("--eco"))).toBe(true);
    expect(SMALL_WORKLIST).toBeLessThan(BATCH_SIZE);
  });

  it("an empty worklist (REAL engine: a REPORT with no citations) is skipped with a notice, not emitted", () => {
    const run = makeRun({ plan: 5, verify: 0 });
    const res = orchestrateRun(run, ENGINE);
    expect(res.exitCode).toBe(0);
    expect(existsSync(wf(run, "verify"))).toBe(false);
    expect(existsSync(wf(run, "gather"))).toBe(true);
    expect(res.notices.some((n) => n.includes("verify") && n.includes("empty"))).toBe(true);
  });

  it("every contract('<role>') referenced by a workflow has its agents/<role>.md", () => {
    const run = makeRun({ plan: 5, verify: 2 });
    orchestrateRun(run, ENGINE);
    const agents = readdirSync(join(run, "orchestration", "agents")).map((f) => f.replace(/\.md$/, ""));
    for (const phase of ["gather", "verify"]) {
      const refs = [...readWf(run, phase).matchAll(/contract\('([a-z-]+)'/g)].map((m) => m[1]!);
      expect(refs.length).toBeGreaterThan(0);
      for (const r of refs) expect(agents).toContain(r);
    }
  });

  it("workflows return fragments and never contain an executed fold step (merge / --apply stay with the orchestrator)", () => {
    const run = makeRun({ plan: 5, verify: 5 });
    orchestrateRun(run, ENGINE);
    for (const phase of ["gather", "verify"]) {
      const src = readWf(run, phase);
      expect(src).toMatch(/^return \{/m);
      // The fold commands may appear only in comments (the orchestrator's next
      // step), never as executed code.
      const code = src
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");
      expect(code).not.toContain("--apply");
      expect(code).not.toContain(" merge ");
    }
  });
});

describe("orchestrate — contracts & runbook", () => {
  it("every emitted contract carries the one-writer footer and returns structured output", () => {
    const run = makeRun({ plan: 2, verify: 2 });
    orchestrateRun(run, ENGINE);
    const dir = join(run, "orchestration", "agents");
    const files = readdirSync(dir);
    expect(files.sort()).toEqual(["gatherer.md", "skeptic.md"]);
    for (const f of files) {
      const md = readFileSync(join(dir, f), "utf8");
      expect(md).toContain("Return, don't write");
      expect(md).toContain("The orchestrator is the sole writer");
      expect(md).toContain("orchestration/out/");
      expect(md).toContain("structured output");
    }
  });

  it("the gatherer contract sanctions ONLY its own sub-dossier writes (the disjoint-write exception)", () => {
    const run = makeRun({ plan: 2 });
    orchestrateRun(run, ENGINE);
    const md = readFileSync(join(run, "orchestration", "agents", "gatherer.md"), "utf8");
    // The playbook's fan-out contract, made explicit: gather/fetch into its OWN
    // out dir only; the parent dossier and report tiers are off-limits.
    expect(md).toMatch(/ONLY/);
    expect(md).toContain("--out");
    expect(md).toContain("disjoint");
    expect(md).toMatch(/NEVER touch the parent run dir/i);
    expect(md).toContain("report tier");
    expect(md).toContain("gather --q");
    expect(md).toContain("--cache");
    expect(md).toContain("fetch --url");
    // The playbook's return contract: out dir + one-line coverage note + NEW sub-questions.
    expect(md).toContain("coverage");
    expect(md).toMatch(/NEW sub-questions/i);
  });

  it("the skeptic contract encodes the four-verdict gate, harsher-when-unsure, and the numeral partial cap", () => {
    const run = makeRun({ verify: 2 });
    orchestrateRun(run, ENGINE);
    const md = readFileSync(join(run, "orchestration", "agents", "skeptic.md"), "utf8");
    for (const v of ["supported", "partial", "unsupported", "refuted"]) expect(md).toContain(`\`${v}\``);
    expect(md).toMatch(/HARSHER/i);
    expect(md).toContain("numeralsAbsent");
    expect(md).toMatch(/caps at `partial`/i);
  });

  it("the runbook covers both phases with concrete paths, the fold commands and the exit gate", () => {
    const run = makeRun({ plan: 5 });
    orchestrateRun(run, ENGINE);
    const rb = readFileSync(join(run, "orchestration", "RUNBOOK.md"), "utf8");
    expect(rb).toContain(join(run, "PLAN.json"));
    expect(rb).toContain(join(run, "VERIFY.todo.json"));
    expect(rb).toContain(ENGINE);
    expect(rb).toContain("gatherer.md");
    expect(rb).toContain("skeptic.md");
    expect(rb).toContain("merge --runs");
    expect(rb).toContain("verify --apply");
    expect(rb).toContain("check --run");
    expect(rb).toContain("--semantic");
    expect(rb).toMatch(/optimization, never a requirement/i);
  });

  it("golden shape (paths normalized)", () => {
    const run = makeRun({ plan: 4, verify: 2 });
    orchestrateRun(run, ENGINE);
    expect(stable(readWf(run, "gather"), run)).toMatchSnapshot("gather.workflow.mjs");
    expect(stable(readFileSync(join(run, "orchestration", "agents", "gatherer.md"), "utf8"), run)).toMatchSnapshot("gatherer.md");
    expect(stable(readFileSync(join(run, "orchestration", "agents", "skeptic.md"), "utf8"), run)).toMatchSnapshot("skeptic.md");
    expect(stable(readFileSync(join(run, "orchestration", "RUNBOOK.md"), "utf8"), run)).toMatchSnapshot("RUNBOOK.md");
  });
});

describe("orchestrate — shell-safe emission (US-2)", () => {
  // A question exercising every shell hazard the emitter must neutralize:
  // command substitution, variable expansion, pipes, quotes and a newline.
  const NASTY = "how much does `uname` cost? it's $99 | maybe\nmore";
  // shq()'s rendering: newline → space, ' → '"'"', wrapped in single quotes.
  const NASTY_SHQ = `'how much does \`uname\` cost? it'"'"'s $99 | maybe more'`;

  function nastyRun(): string {
    const run = mkdtempSync(join(tmpdir(), "us-orch-nasty-"));
    runPlan(NASTY, "topic", ["angle one about pricing", "angle two about safety"], 2, run, "standard");
    return run;
  }

  it("single-quotes the question and the paths in the gather prerequisite", () => {
    const run = nastyRun();
    const [gather] = listPhases(run, ENGINE);
    expect(gather!.prerequisite).toContain(`--q ${NASTY_SHQ}`);
    expect(gather!.prerequisite).toContain(`--run-root '${run}'`);
    expect(gather!.prerequisite).not.toContain("\n");
  });

  it("single-quotes the question and the paths in the workflow-tail merge fold", () => {
    const run = nastyRun();
    orchestrateRun(run, ENGINE);
    const src = readWf(run, "gather");
    expect(src).toContain(`--q ${NASTY_SHQ}`);
    expect(src).toContain(`--master '${run}'`);
    expect(src).toContain(`--runs '${join(run, "q1")},${join(run, "q2")}'`);
  });

  it("the RUNBOOK merge command quotes the question — it stays equal to PLAN.json's question", () => {
    const run = nastyRun();
    orchestrateRun(run, ENGINE);
    const rb = readFileSync(join(run, "orchestration", "RUNBOOK.md"), "utf8");
    expect(rb).toContain(`--q ${NASTY_SHQ}`);
    // the paths in every runnable step are quoted too
    expect(rb).toContain(`--run '${run}'`);
    expect(rb).toContain(`--master '${run}'`);
  });

  it("the RUNBOOK phase-status table survives pipes and newlines in the prerequisite", () => {
    const run = nastyRun();
    orchestrateRun(run, ENGINE);
    const rb = readFileSync(join(run, "orchestration", "RUNBOOK.md"), "utf8");
    const rows = rb.split("\n").filter((l) => l.startsWith("| gather |"));
    expect(rows.length).toBe(1); // one line — the newline was collapsed
    const row = rows[0]!;
    // pipes inside cells are escaped, so the row still has exactly 4 columns
    expect(row).toContain("\\|");
    expect(row.split(/(?<!\\)\|/).length - 2).toBe(4);
  });
});

describe("orchestrate — eco mode & phase gating", () => {
  it("--eco emits RUNBOOK + contracts only, no workflow scripts", () => {
    const run = makeRun({ plan: 5, verify: 2 });
    const res = orchestrateRun(run, ENGINE, { eco: true });
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(run, "orchestration", "RUNBOOK.md"))).toBe(true);
    expect(existsSync(join(run, "orchestration", "agents", "gatherer.md"))).toBe(true);
    expect(existsSync(join(run, "orchestration", "agents", "skeptic.md"))).toBe(true);
    expect(existsSync(wf(run, "gather"))).toBe(false);
    expect(existsSync(wf(run, "verify"))).toBe(false);
  });

  it("--phase on a not-ready phase exits 2 and names the producing command", () => {
    const run = makeRun({ verify: 2 });
    const res = orchestrateRun(run, ENGINE, { phase: "gather" });
    expect(res.exitCode).toBe(2);
    expect(res.errors.some((e) => e.includes("plan"))).toBe(true);
    expect(existsSync(wf(run, "gather"))).toBe(false);
    const run2 = makeRun({ plan: 2 });
    const res2 = orchestrateRun(run2, ENGINE, { phase: "verify" });
    expect(res2.exitCode).toBe(2);
    expect(res2.errors.some((e) => e.includes("verify --run"))).toBe(true);
  });

  it("--phase restricts emission to that phase", () => {
    const run = makeRun({ plan: 5, verify: 2 });
    const res = orchestrateRun(run, ENGINE, { phase: "verify" });
    expect(res.exitCode).toBe(0);
    expect(existsSync(wf(run, "verify"))).toBe(true);
    expect(existsSync(wf(run, "gather"))).toBe(false);
  });

  it("an unknown phase exits 2 naming the valid ones", () => {
    const run = makeRun({ verify: 2 });
    const res = orchestrateRun(run, ENGINE, { phase: "nope" });
    expect(res.exitCode).toBe(2);
    expect(res.errors.some((e) => e.includes("gather") && e.includes("verify"))).toBe(true);
  });

  it("a missing run dir exits 2", () => {
    const res = orchestrateRun(join(tmpdir(), "us-orch-does-not-exist-xyz"), ENGINE);
    expect(res.exitCode).toBe(2);
  });
});

describe("orchestrate — CLI wiring", () => {
  it("orchestrate without --run exits 2", async () => {
    expect((await run(["orchestrate"])).exit).toBe(2);
  });

  it("orchestrate --run <dir> --list prints {phases:[…]} JSON; a full run emits and succeeds", async () => {
    const dir = makeRun({ plan: 2 });
    const list = await run(["orchestrate", "--run", dir, "--list"]);
    expect(list.exit).toBeUndefined();
    const parsed = JSON.parse(list.out) as { phases: { name: string; ready: boolean }[] };
    expect(parsed.phases.map((p) => p.name)).toEqual(["gather", "verify"]);
    const full = await run(["orchestrate", "--run", dir]);
    expect(full.exit).toBeUndefined();
    expect(full.out).toContain("Workflow({ scriptPath:");
    expect(existsSync(wf(dir, "gather"))).toBe(true);
  });

  it("orchestrate --run <missing dir> exits 2 (also with --list)", async () => {
    const missing = join(tmpdir(), "us-orch-missing-xyz");
    expect((await run(["orchestrate", "--run", missing])).exit).toBe(2);
    expect((await run(["orchestrate", "--run", missing, "--list"])).exit).toBe(2);
  });

  it("orchestrate --run <dir> --phase <not-ready> exits 2 via the CLI", async () => {
    const dir = makeRun({ plan: 2 });
    const r = await run(["orchestrate", "--run", dir, "--phase", "verify"]);
    expect(r.exit).toBe(2);
    expect(r.err).toContain("verify --run");
  });
});
