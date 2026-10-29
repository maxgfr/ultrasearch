import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";
import { runCheck } from "../src/check.js";
import { applyVerdicts, runVerify } from "../src/verify.js";
import { DEEP_CAPS } from "../src/types.js";
import { writeFixtureDossier } from "./dossierfix.js";

// A research run's report carried 122 claim↔source pairs; `verify` emitted 40
// (DEEP_CAPS.maxVerify) without saying the list was cut, and `check
// --require-verify` re-derived the same capped 40 — so the gate passed with 82
// pairs nobody had judged.

const CLAIMS = 30; // × 3 cited sources = 90 pairs, over the default cap
const TOTAL = CLAIMS * 3;

function dossier(): string {
  const dir = mkdtempSync(join(tmpdir(), "us-vcap-"));
  writeFixtureDossier(dir, 3);
  for (const id of ["S1", "S2", "S3"]) {
    writeFileSync(join(dir, "sources", `${id}.md`), `# ${id}\nRate limiting caps request rates in a fixed window to protect the server.\n`);
  }
  const body = Array.from({ length: CLAIMS }, (_, i) => `Rate limiting caps request rates in window number ${i + 1}. [S1][S2][S3]`).join("\n\n");
  writeFileSync(join(dir, "REPORT.md"), `# Rate limiting\n\n${body}\n`);
  writeFileSync(join(dir, "SUMMARY.md"), "# Summary\n\nRate limiting caps request rates. [S1]\n");
  return dir;
}

function adjudicateAll(dir: string): void {
  const todo = JSON.parse(readFileSync(join(dir, "VERIFY.todo.json"), "utf8"));
  const f = join(dir, "verdicts.json");
  writeFileSync(f, JSON.stringify({ pairs: todo.pairs.map((p: Record<string, unknown>) => ({ ...p, verdict: "supported", note: "ok" })) }));
  applyVerdicts(dir, f);
}

async function run(argv: string[]): Promise<{ out: string; err: string; exit?: number }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
    out.push(String(c));
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => {
    err.push(String(c));
    return true;
  }) as never);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  let exit: number | undefined;
  try {
    await main(argv);
  } catch (er) {
    const m = /^exit:(\d+)$/.exec((er as Error).message);
    if (!m) throw er;
    exit = Number(m[1]);
  } finally {
    vi.restoreAllMocks();
  }
  return { out: out.join(""), err: err.join(""), exit };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("verify's pair cap is never silent", () => {
  it("warns on stderr with the total and how to raise --max-verify when the worklist is cut", async () => {
    const dir = dossier();
    dirs.push(dir);
    const r = await run(["verify", "--run", dir]);
    expect(r.exit).toBeUndefined();
    expect(r.err).toContain(`${DEEP_CAPS.maxVerify} of ${TOTAL}`);
    expect(r.err).toContain(`--max-verify ${TOTAL}`);
  });

  it("says nothing about a cap when every pair fits", async () => {
    const dir = dossier();
    dirs.push(dir);
    const r = await run(["verify", "--run", dir, "--max-verify", String(TOTAL)]);
    expect(r.err).not.toMatch(/--max-verify/);
  });

  it("warns on a sharded run too, counting the cap before the stripe", async () => {
    const dir = dossier();
    dirs.push(dir);
    const r = await run(["verify", "--run", dir, "--shards", "2", "--shard", "0"]);
    expect(r.err).toContain(`${DEEP_CAPS.maxVerify} of ${TOTAL}`);
  });
});

describe("check --require-verify covers every pair, not just the capped worklist", () => {
  it("fails when the default cap left pairs unadjudicated, and names the flag that fixes it", () => {
    const dir = dossier();
    dirs.push(dir);
    expect(runVerify(dir).pairs.length).toBe(DEEP_CAPS.maxVerify);
    adjudicateAll(dir);
    const res = runCheck(dir, { semantic: true, requireVerify: true });
    expect(res.ok).toBe(false);
    const msg = res.errors.join("\n");
    expect(msg).toContain(`${TOTAL - DEEP_CAPS.maxVerify} claim↔source pair(s)`);
    expect(msg).toContain(`--max-verify ${TOTAL}`);
  });

  it("passes once a raised --max-verify had every pair adjudicated", () => {
    const dir = dossier();
    dirs.push(dir);
    expect(runVerify(dir, { maxVerify: TOTAL }).pairs.length).toBe(TOTAL);
    adjudicateAll(dir);
    const res = runCheck(dir, { semantic: true, requireVerify: true });
    expect(res.errors.filter((e) => /require-verify/.test(e))).toEqual([]);
  });

  it("plain --semantic keeps judging only what was adjudicated", () => {
    const dir = dossier();
    dirs.push(dir);
    runVerify(dir);
    adjudicateAll(dir);
    const res = runCheck(dir, { semantic: true });
    expect(res.errors.filter((e) => /pair\(s\) in REPORT have no verdict/.test(e))).toEqual([]);
  });
});
