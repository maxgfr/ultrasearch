import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";
import { isNoWrite, resetNoWrite, setNoWrite, takeArtifacts, writeArtifact } from "../src/no-write.js";
import { callTool } from "../src/mcp/handlers.js";
import { annotationsFor } from "../src/mcp/tools.js";

// The whole point of --stdout is a NEGATIVE claim: the filesystem is untouched.
// Asserting the stdout stream looks right proves nothing about that, so the
// load-bearing test here compares a recursive listing before and after a real
// (offline, fixture-backed) run — including the fetch cache dir, which
// tests/setup.ts pins to a temp path.

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
  // The refusals set process.exitCode rather than calling process.exit, so both
  // paths have to be captured to tell "refused" from "crashed".
  const x = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  process.exitCode = undefined;
  let exit: number | undefined;
  try {
    await main(argv);
    exit = process.exitCode as number | undefined;
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
  process.exitCode = undefined;
  o.mockRestore();
  e.mockRestore();
  x.mockRestore();
  return { out: out.join(""), err: err.join(""), exit };
}

// Every path under `root`, relative and sorted — a stable fingerprint of a tree.
function tree(root: string): string[] {
  if (!existsSync(root)) return [];
  const acc: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      acc.push(relative(root, p));
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  walk(root);
  return acc.sort();
}

const CACHE = process.env.ULTRASEARCH_CACHE_DIR!;
const GATHER = ["gather", "--q", "rate limiting", "--backends", "fixture"];

let sandbox: string;
beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "us-no-write-"));
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
afterEach(() => resetNoWrite());

describe("the gate itself", () => {
  it("collects instead of writing, and lets the last write win on a path", () => {
    const p = join(sandbox, "gate", "X.md");
    setNoWrite(true);
    expect(isNoWrite()).toBe(true);
    expect(writeArtifact(p, "first")).toBe(p); // returns the path either way
    writeArtifact(p, "second");
    expect(existsSync(p)).toBe(false);
    expect(takeArtifacts()).toEqual([{ path: p, content: "second" }]);
    expect(takeArtifacts()).toEqual([]); // draining is destructive
  });

  it("is off by default and reads ULTRASEARCH_NO_WRITE at call time", () => {
    expect(isNoWrite()).toBe(false);
    process.env.ULTRASEARCH_NO_WRITE = "1";
    try {
      expect(isNoWrite()).toBe(true);
    } finally {
      delete process.env.ULTRASEARCH_NO_WRITE;
    }
    expect(isNoWrite()).toBe(false);
  });
});

describe("gather --stdout", () => {
  it("writes NOTHING — not the run dir, not the fetch cache", async () => {
    const out = join(sandbox, "never-created");
    const cacheBefore = tree(CACHE);

    const r = await run([...GATHER, "--stdout", "--out", out]);

    expect(r.exit ?? 0).toBe(0);
    expect(existsSync(out)).toBe(false);
    expect(tree(CACHE)).toEqual(cacheBefore);
  });

  it("streams DOSSIER.md first, then every source extract in order", async () => {
    const r = await run([...GATHER, "--stdout", "--out", join(sandbox, "n2")]);
    const headers = [...r.out.matchAll(/^===== (.+) =====$/gm)].map((m) => m[1]!);

    expect(headers[0]).toBe("DOSSIER.md");
    const extracts = headers.slice(1);
    expect(extracts.length).toBeGreaterThan(0);
    expect(extracts).toEqual([...extracts].sort((a, b) => Number(/S(\d+)/.exec(a)![1]) - Number(/S(\d+)/.exec(b)![1])));
    // The curated text set omits what only restates DOSSIER.md.
    expect(headers).not.toContain("sources.json");
    expect(headers).not.toContain("manifest.json");
    // Full extracts, not just the 480-char snippets DOSSIER.md carries.
    expect(r.out).toContain("- backend: fixture");
  });

  it("tells the reader the truth: no tiers to write, no check gate, no fetch bridge", async () => {
    const r = await run([...GATHER, "--stdout", "--out", join(sandbox, "n3")]);

    expect(r.out).toContain("Nothing was written");
    expect(r.out).toContain("`ultrasearch check` cannot run here");
    expect(r.out).not.toContain("`REPORT.md`");
    expect(r.out).not.toContain("fetch --url");
    expect(r.err).toContain("nothing written; the dossier is on stdout");
    expect(r.err).not.toMatch(/ultrasearch render --run/);
  });

  it("--json carries every artifact losslessly, with a null dir", async () => {
    const r = await run([...GATHER, "--stdout", "--json", "--out", join(sandbox, "n4")]);
    const parsed = JSON.parse(r.out) as { dir: null; manifest: { sourceCount: number }; artifacts: Record<string, string> };

    expect(parsed.dir).toBeNull(); // never name a path that was not created
    expect(parsed.manifest.sourceCount).toBeGreaterThan(0);
    expect(Object.keys(parsed.artifacts)).toEqual(expect.arrayContaining(["DOSSIER.md", "sources.json", "manifest.json", "sources/S1.md"]));
  });

  it("still writes the full dossier without the flag (the default is untouched)", async () => {
    const out = join(sandbox, "normal");
    const r = await run([...GATHER, "--out", out]);

    expect(r.exit ?? 0).toBe(0);
    expect(tree(out)).toEqual(expect.arrayContaining(["DOSSIER.md", "manifest.json", "sources", "sources.json", join("sources", "S1.md")]));
    expect(r.err).toContain("ultrasearch render --run");
  });
});

describe("the other producers", () => {
  it("brainstorm --stdout streams BRAINSTORM.md and creates no dir", async () => {
    const out = join(sandbox, "bs");
    const r = await run(["brainstorm", "--q", "rust", "--backends", "fixture", "--stdout", "--out", out]);

    expect(r.out).toContain("===== BRAINSTORM.md =====");
    expect(r.out).not.toContain("===== BRAINSTORM.json =====");
    expect(existsSync(out)).toBe(false);
  });

  it("plan --stdout keeps its JSON payload and creates no run root", async () => {
    const root = join(sandbox, "planroot");
    const r = await run(["plan", "--q", "how does rate limiting work", "--run-root", root, "--stdout"]);
    const parsed = JSON.parse(r.out) as { subQuestions: { out?: string }[] };

    expect(parsed.subQuestions.length).toBeGreaterThan(0);
    expect(parsed.subQuestions[0]!.out).toContain(root); // still a hint for a later writing run
    expect(r.out).not.toContain("====="); // the payload is not repeated as an artifact
    expect(existsSync(root)).toBe(false);
  });

  it("render --stdout emits index.md only, and refuses when --no-md leaves nothing", async () => {
    const dossier = join(sandbox, "renderable");
    await run([...GATHER, "--out", dossier]);
    writeFileSync(join(dossier, "REPORT.md"), "# R\n\nRate limiting caps request rates. [S1]\n");
    const before = tree(dossier);

    const r = await run(["render", "--run", dossier, "--stdout"]);
    expect(r.out).toContain("===== index.md =====");
    expect(r.out).not.toContain("<!doctype html");
    expect(tree(dossier)).toEqual(before); // no index.md, no index.html

    const bad = await run(["render", "--run", dossier, "--stdout", "--no-md"]);
    expect(bad.exit).toBe(2);
    expect(bad.err).toContain("leaves nothing to emit");
  });
});

describe("commands that exist to leave files behind", () => {
  const cases: [string, string[]][] = [
    ["merge", ["merge", "--runs", "/tmp/a,/tmp/b", "--master", "/tmp/m"]],
    ["fetch", ["fetch", "--url", "https://example.test", "--out", "/tmp/d"]],
    ["add-source", ["add-source", "--url", "https://example.test", "--out", "/tmp/d"]],
    ["verify", ["verify", "--run", "/tmp/d"]],
    ["orchestrate", ["orchestrate", "--run", "/tmp/d"]],
  ];

  it.each(cases)("%s refuses with exit 2 and names the way out", async (name, argv) => {
    const r = await run([...argv, "--stdout"]);

    expect(r.exit).toBe(2);
    expect(r.err).toContain(`\`${name}\` cannot run without writing`);
    expect(r.err).toContain("Drop --stdout / ULTRASEARCH_NO_WRITE=1");
  });

  it("refuses on the env var alone, with no flag", async () => {
    process.env.ULTRASEARCH_NO_WRITE = "1";
    try {
      const r = await run(["merge", "--runs", "/tmp/a", "--master", "/tmp/m"]);
      expect(r.exit).toBe(2);
    } finally {
      delete process.env.ULTRASEARCH_NO_WRITE;
    }
  });

  it("leaves the write-free commands alone — --stdout is an accepted no-op", async () => {
    const r = await run(["check", "--run", "assets/example-dossier", "--stdout"]);
    expect(r.exit ?? 0).toBe(0);

    const m = await run(["modes", "--stdout", "--json"]);
    expect(JSON.parse(m.out).length).toBeGreaterThan(0);
  });
});

describe("ULTRASEARCH_NO_WRITE and the MCP server", () => {
  beforeAll(() => {
    process.env.ULTRASEARCH_NO_WRITE = "1";
  });
  afterAll(() => {
    delete process.env.ULTRASEARCH_NO_WRITE;
  });

  it("returns the dossier inline instead of a path", async () => {
    const res = await callTool("ultrasearch_gather", { question: "rate limiting", backends: ["fixture"], depth: "summary" });
    const parsed = JSON.parse(res.text) as { run: null; artifacts: Record<string, string>; next: string };

    expect(parsed.run).toBeNull();
    expect(parsed.artifacts["DOSSIER.md"]).toContain("# Search dossier");
    expect(parsed.next).toContain("Nothing was written");
    // No on-disk artifact for an over-cap refusal to point at.
    expect(res.artifact).toBeUndefined();
  });

  it("refuses the tools whose product is a file on disk", async () => {
    await expect(callTool("ultrasearch_fetch", { run: "/tmp/d", url: "https://example.test" })).rejects.toThrow(/cannot run while ULTRASEARCH_NO_WRITE is set/);
    await expect(callTool("ultrasearch_merge", { runs: ["/tmp/a", "/tmp/b"] })).rejects.toThrow(/cannot run while ULTRASEARCH_NO_WRITE is set/);
    await expect(callTool("ultrasearch_verify", { run: "/tmp/d" })).rejects.toThrow(/cannot run while ULTRASEARCH_NO_WRITE is set/);
  });

  it("stops advertising the write tools as writers", () => {
    expect(annotationsFor("ultrasearch_gather")).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(annotationsFor("ultrasearch_render")).toEqual({ readOnlyHint: true, openWorldHint: false });
  });
});
