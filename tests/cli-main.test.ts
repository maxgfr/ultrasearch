import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";

// Drive main() IN-PROCESS (not spawned) so vitest's V8 coverage instruments the
// whole command-dispatch surface of src/cli.ts. main() writes to stdout/stderr
// and calls process.exit on errors — capture both. Everything here runs offline
// via the `fixture` backend / local dossiers, so no network is touched.
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

const EXAMPLE = "assets/example-dossier"; // committed, grounded — read-only checks only

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "us-cli-main-"));
  const r = await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--out", dir]);
  expect(r.exit).toBeUndefined();
  expect(existsSync(join(dir, "sources.json"))).toBe(true);
  // A minimal REPORT so verify has claim↔source pairs to emit.
  writeFileSync(join(dir, "REPORT.md"), "# Report\n\nRate limiting controls how many requests a client may make. [S1]\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("main() — help / version / unknown", () => {
  it("prints help (exit 0) and version (exit 0), rejects an unknown command (exit 1)", async () => {
    expect((await run(["--help"])).exit).toBe(0);
    expect((await run(["-v"])).exit).toBe(0);
    expect((await run([])).exit).toBe(0); // no args → help
    expect((await run(["frobnicate"])).exit).toBe(1);
  });
});

describe("main() — modes", () => {
  it("lists modes as text and as JSON", async () => {
    const text = await run(["modes"]);
    expect(text.out).toMatch(/topic/);
    const j = await run(["modes", "--json"]);
    const modes = JSON.parse(j.out);
    expect(Array.isArray(modes)).toBe(true);
    expect(modes.some((m: { name: string }) => m.name === "topic")).toBe(true);
  });
});

describe("main() — brainstorm", () => {
  it("probes a vague question and prints angles + user questions (text + json)", async () => {
    const d = mkdtempSync(join(tmpdir(), "us-cli-brainstorm-"));
    const text = await run(["brainstorm", "--q", "rust", "--backends", "fixture", "--out", d]);
    expect(text.out).toMatch(/under-specified|specific enough/);
    expect(text.out).toMatch(/ask the user/i);
    expect(existsSync(join(d, "BRAINSTORM.md"))).toBe(true);
    const j = await run(["brainstorm", "--q", "rust", "--backends", "fixture", "--out", d, "--json"]);
    expect(JSON.parse(j.out).signals.ambiguous).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("main() — gather", () => {
  it("emits a human summary to stderr by default", async () => {
    const d = mkdtempSync(join(tmpdir(), "us-cli-gather-"));
    const r = await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--out", d]);
    expect(r.exit).toBeUndefined();
    expect(r.err).toMatch(/source\(s\) for/);
    rmSync(d, { recursive: true, force: true });
  });

  it("emits {dir, manifest} JSON with --json", async () => {
    const d = mkdtempSync(join(tmpdir(), "us-cli-gatherj-"));
    const r = await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--out", d, "--json"]);
    const parsed = JSON.parse(r.out);
    expect(parsed.dir).toBeTruthy();
    expect(parsed.manifest).toBeTruthy();
    rmSync(d, { recursive: true, force: true });
  });
});

describe("main() — search", () => {
  it("drills one backend as text and as JSON, and rejects a missing --backend", async () => {
    const text = await run(["search", "--backend", "fixture", "--q", "rate limiting"]);
    expect(text.out).toMatch(/fixture — \d+ result/);
    expect(text.out).toMatch(/\[S1\]/);
    const j = await run(["search", "--backend", "fixture", "--q", "rate limiting", "--json"]);
    expect(JSON.parse(j.out).items.length).toBeGreaterThan(0);
    expect((await run(["search", "--q", "x"])).exit).toBe(1); // missing --backend
  });
});

describe("main() — plan", () => {
  it("decomposes a question to JSON, and gives each sub-question an out dir with --run-root", async () => {
    const plain = await run(["plan", "--q", "how does rate limiting work"]);
    expect(Array.isArray(JSON.parse(plain.out).subQuestions)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "us-cli-plan-"));
    const withRoot = await run(["plan", "--q", "how does rate limiting work", "--run-root", root]);
    const sq = JSON.parse(withRoot.out).subQuestions;
    expect(sq[0].out).toContain(root);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("main() — merge (error paths)", () => {
  it("fails with no --runs and on a non-existent run dir", async () => {
    expect((await run(["merge"])).exit).toBe(1);
    expect((await run(["merge", "--runs", "/no/such/dir-xyz"])).exit).toBe(1);
  });
});

describe("main() — fetch (error paths)", () => {
  it("fails on a missing --out and a missing --url", async () => {
    expect((await run(["fetch"])).exit).toBe(1);
    expect((await run(["fetch", "--out", dir])).exit).toBe(1); // no --url
  });
});

describe("main() — render", () => {
  it("writes html+md by default, honors --no-html/--no-md, and reports paths with --json", async () => {
    const both = await run(["render", "--run", dir]);
    expect(both.err).toMatch(/wrote .*index\.html/);
    expect(both.err).toMatch(/wrote .*index\.md/);
    const noHtml = await run(["render", "--run", dir, "--no-html"]);
    expect(noHtml.err).not.toMatch(/index\.html/);
    const noMd = await run(["render", "--run", dir, "--no-md"]);
    expect(noMd.err).not.toMatch(/index\.md/);
    const j = await run(["render", "--run", dir, "--json"]);
    const written = JSON.parse(j.out);
    expect(written.html || written.md).toBeTruthy();
  });
});

describe("main() — check", () => {
  it("passes on the grounded example dossier (text + JSON)", async () => {
    const text = await run(["check", "--run", EXAMPLE]);
    expect(text.exit).toBeUndefined();
    const j = await run(["check", "--run", EXAMPLE, "--json"]);
    expect(JSON.parse(j.out).ok).toBe(true);
  });

  it("fails (exit 1) a freshly gathered dossier that has no grounded report", async () => {
    const d = mkdtempSync(join(tmpdir(), "us-cli-check-"));
    await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--out", d]);
    const r = await run(["check", "--run", d]); // no REPORT.md → ungrounded
    expect(r.exit).toBe(1);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("main() — verify", () => {
  it("emits a claim↔source worklist (text + JSON) and a single shard", async () => {
    const wl = await run(["verify", "--run", dir]);
    expect(existsSync(join(dir, "VERIFY.todo.json"))).toBe(true);
    expect(wl.err).toMatch(/pair\(s\)/);
    const j = await run(["verify", "--run", dir, "--json"]);
    expect(JSON.parse(j.out)).toHaveProperty("pairs");
    const sh = await run(["verify", "--run", dir, "--shards", "2", "--shard", "0"]);
    expect(existsSync(join(dir, "VERIFY.todo.0.json"))).toBe(true);
    expect(sh.err).toMatch(/shard 0 of 2/);
  });

  it("applies a verdicts file: passes when supported, exits 1 when refuted", async () => {
    await run(["verify", "--run", dir]); // (re)write VERIFY.todo.json
    const todo = JSON.parse(readFileSync(join(dir, "VERIFY.todo.json"), "utf8"));
    const write = (verdict: string) => {
      const pairs = todo.pairs.map((p: { sourceId: string }) => ({ ...p, verdict, note: "" }));
      const f = join(dir, `verdicts-${verdict}.json`);
      writeFileSync(f, JSON.stringify({ pairs }));
      return f;
    };
    const ok = await run(["verify", "--run", dir, "--apply", write("supported")]);
    expect(ok.exit).toBeUndefined();
    const bad = await run(["verify", "--run", dir, "--apply", write("refuted"), "--json"]);
    expect(bad.exit).toBe(1);
  });
});
