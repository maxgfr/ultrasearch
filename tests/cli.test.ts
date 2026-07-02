import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, buildGatherOptions, parseShardArgs, resolveApplyPaths, HELP, VALUE_FLAGS, BOOL_FLAGS } from "../src/cli.js";

// parseArgs calls process.exit on help/version/errors; make it throw so we can
// assert on it without killing the test runner, and silence the writes.
beforeEach(() => {
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe("parseArgs", () => {
  it("parses a command, value flags (--k v) and bool flags", () => {
    const p = parseArgs(["gather", "--q", "hello world", "--mode", "bug", "--json"]);
    expect(p.command).toBe("gather");
    expect(p.values.q).toBe("hello world");
    expect(p.values.mode).toBe("bug");
    expect(p.bools.has("json")).toBe(true);
  });

  it("parses --k=v form", () => {
    const p = parseArgs(["gather", "--q=hi", "--depth=deep"]);
    expect(p.values.q).toBe("hi");
    expect(p.values.depth).toBe("deep");
  });

  it("rejects an unknown command", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(/exit:1/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["gather", "--nope", "x"])).toThrow(/exit:1/);
  });

  it("rejects a value given to a boolean flag", () => {
    expect(() => parseArgs(["gather", "--json=1"])).toThrow(/exit:1/);
  });

  it("accepts the deep-tier value flags (--run-root, --shards, --shard, --min-sources)", () => {
    const p = parseArgs(["verify", "--run", "/d", "--shards", "3", "--shard", "0"]);
    expect(p.values.shards).toBe("3");
    expect(p.values.shard).toBe("0");
    const q = parseArgs(["plan", "--q", "x", "--run-root", "/tmp/deep"]);
    expect(q.values["run-root"]).toBe("/tmp/deep");
    const c = parseArgs(["check", "--run", "/d", "--min-sources", "5"]);
    expect(c.values["min-sources"]).toBe("5");
  });

  it("rejects a missing value at end of argv", () => {
    expect(() => parseArgs(["gather", "--q"])).toThrow(/exit:1/);
  });

  it("exits 0 on --help and --version", () => {
    expect(() => parseArgs(["--help"])).toThrow(/exit:0/);
    expect(() => parseArgs(["-v"])).toThrow(/exit:0/);
  });
});

// SKILL.md tells agents "run --help for the full surface" — keep that promise:
// every accepted flag must appear in HELP. The lookahead stops --run matching
// only inside --run-root (and --shard inside --shards).
describe("HELP covers the whole flag surface", () => {
  it("mentions every value and boolean flag", () => {
    for (const flag of [...VALUE_FLAGS, ...BOOL_FLAGS]) {
      expect(HELP, `--${flag} missing from --help`).toMatch(new RegExp(`--${flag}(?![a-z0-9-])`));
    }
  });
});

describe("buildGatherOptions", () => {
  it("splits --queries on '|' into a trimmed, non-empty list", () => {
    const opts = buildGatherOptions(parseArgs(["gather", "--q", "x", "--queries", "a | b |  | c"]));
    expect(opts.queries).toEqual(["a", "b", "c"]);
  });
  it("leaves queries undefined when the flag is absent", () => {
    expect(buildGatherOptions(parseArgs(["gather", "--q", "x"])).queries).toBeUndefined();
  });
  it("parses --pages/--web-breadth/--region and clamps pages/web-breadth to 5", () => {
    const o = buildGatherOptions(parseArgs(["gather", "--q", "x", "--pages", "9", "--web-breadth", "7", "--region", "de"]));
    expect(o.pages).toBe(5);
    expect(o.webBreadth).toBe(5);
    expect(o.region).toBe("de");
  });
  it("leaves pages/webBreadth/region undefined when absent (defaults resolved at gather time)", () => {
    const o = buildGatherOptions(parseArgs(["gather", "--q", "x"]));
    expect(o.pages).toBeUndefined();
    expect(o.webBreadth).toBeUndefined();
    expect(o.region).toBeUndefined();
  });
});

describe("parseShardArgs (verify --shards/--shard validation)", () => {
  it("accepts a valid shards/shard pair", () => {
    expect(parseShardArgs("3", "0")).toEqual({ ok: true, shards: 3, shard: 0 });
    expect(parseShardArgs("3", "2")).toEqual({ ok: true, shards: 3, shard: 2 });
  });
  it("is a no-op when neither flag is given", () => {
    expect(parseShardArgs(undefined, undefined)).toEqual({ ok: true, shards: undefined, shard: undefined });
  });
  it("rejects --shards without --shard and vice versa", () => {
    expect(parseShardArgs("3", undefined)).toMatchObject({ ok: false });
    expect((parseShardArgs("3", undefined) as any).error).toMatch(/requires --shard/);
    expect((parseShardArgs(undefined, "0") as any).error).toMatch(/requires --shards/);
  });
  it("rejects an out-of-range shard (shard >= shards) at the boundary", () => {
    expect((parseShardArgs("3", "3") as any).error).toMatch(/out of range/);
    expect(parseShardArgs("3", "2").ok).toBe(true); // last valid index
  });
  it("rejects non-integer / negative inputs", () => {
    expect((parseShardArgs("0", "0") as any).error).toMatch(/invalid --shards/);
    expect((parseShardArgs("2", "-1") as any).error).toMatch(/invalid --shard/);
    expect((parseShardArgs("2.5", "0") as any).error).toMatch(/invalid --shards/);
  });
});

describe("resolveApplyPaths (verify --apply file | comma-list | directory)", () => {
  it("returns a single resolved path for a plain file spec", () => {
    const r = resolveApplyPaths("verdicts.json");
    expect(r).toHaveLength(1);
    expect(basename(r[0]!)).toBe("verdicts.json");
  });
  it("splits a comma list into resolved paths", () => {
    const r = resolveApplyPaths("a.json, b.json");
    expect(r.map((p) => basename(p))).toEqual(["a.json", "b.json"]);
  });
  it("picks up only *verdict*.json from a directory, sorted, excluding VERIFY.* outputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-apply-"));
    for (const f of ["verdicts.1.json", "verdicts.0.json", "VERIFY.json", "VERIFY.todo.0.json", "scratch.json"]) {
      writeFileSync(join(dir, f), "{}");
    }
    const r = resolveApplyPaths(dir);
    expect(r.map((p) => basename(p))).toEqual(["verdicts.0.json", "verdicts.1.json"]);
    rmSync(dir, { recursive: true, force: true });
  });
  it("fails on a directory with no verdict files", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-apply-empty-"));
    writeFileSync(join(dir, "VERIFY.json"), "{}");
    expect(() => resolveApplyPaths(dir)).toThrow(/exit:1/);
    rmSync(dir, { recursive: true, force: true });
  });
});
