import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, buildGatherOptions, parseShardArgs, resolveApplyPaths, HELP, VALUE_FLAGS, BOOL_FLAGS } from "../src/cli.js";
import { helpCoversFlag } from "../scripts/drift-rules.mjs";

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
// every accepted flag must appear in HELP. This is the SOURCE-layer twin of
// assertion B in scripts/verify-skill-bundle.mjs (which checks the built
// bundle); both call the SAME helpCoversFlag matcher from scripts/drift-rules,
// so the two gates can no longer drift apart.
describe("HELP covers the whole flag surface", () => {
  it("mentions every value and boolean flag", () => {
    for (const flag of [...VALUE_FLAGS, ...BOOL_FLAGS]) {
      expect(helpCoversFlag(HELP, flag), `--${flag} missing from --help`).toBe(true);
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

  it("resolves and de-duplicates --backends, preserving first-seen order", () => {
    const o = buildGatherOptions(parseArgs(["gather", "--q", "x", "--backends", "github, arxiv , github"]));
    expect(o.backends).toEqual(["github", "arxiv"]);
  });

  it("rejects an unknown backend, and a list that resolves to nothing", () => {
    expect(() => buildGatherOptions(parseArgs(["gather", "--q", "x", "--backends", "bogus"]))).toThrow(/exit:1/);
    expect(() => buildGatherOptions(parseArgs(["gather", "--q", "x", "--backends", " , "]))).toThrow(/exit:1/);
  });

  it("rejects an invalid --mode / --depth / --web-engine via oneOf", () => {
    expect(() => buildGatherOptions(parseArgs(["gather", "--q", "x", "--mode", "nope"]))).toThrow(/exit:1/);
    expect(() => buildGatherOptions(parseArgs(["gather", "--q", "x", "--depth", "nope"]))).toThrow(/exit:1/);
    expect(() => buildGatherOptions(parseArgs(["gather", "--q", "x", "--web-engine", "nope"]))).toThrow(/exit:1/);
  });

  it("rejects non-positive / non-numeric numeric flags", () => {
    expect(() => buildGatherOptions(parseArgs(["gather", "--q", "x", "--max-sources", "-1"]))).toThrow(/exit:1/);
    expect(() => buildGatherOptions(parseArgs(["gather", "--q", "x", "--per-source", "0"]))).toThrow(/exit:1/);
    expect(() => buildGatherOptions(parseArgs(["gather", "--q", "x", "--concurrency", "abc"]))).toThrow(/exit:1/);
    expect(() => buildGatherOptions(parseArgs(["gather", "--q", "x", "--rounds", "nan"]))).toThrow(/exit:1/);
  });

  it("requires --q by default but allows an empty question when requireQuestion:false (search)", () => {
    expect(() => buildGatherOptions(parseArgs(["gather"]))).toThrow(/exit:1/);
    const o = buildGatherOptions(parseArgs(["search", "--backend", "fixture"]), { requireQuestion: false });
    expect(o.question).toBe("");
  });

  it("threads the optional flags through into GatherOptions", () => {
    const o = buildGatherOptions(
      parseArgs([
        "gather",
        "--q",
        "x",
        "--concurrency",
        "4",
        "--rounds",
        "2",
        "--cache",
        "--since",
        "2020-01-01",
        "--exclude-domains",
        "a.com, b.com",
        "--url",
        "https://u1,https://u2",
        "--searxng",
        "http://sx",
        "--out",
        "/tmp/us-out",
      ]),
    );
    expect(o.concurrency).toBe(4);
    expect(o.rounds).toBe(2);
    expect(o.cache).toBe(true);
    expect(o.since).toBe("2020-01-01");
    expect(o.excludeDomains).toEqual(["a.com", "b.com"]);
    expect(o.urls).toEqual(["https://u1", "https://u2"]);
    expect(o.searxng).toBe("http://sx");
    expect(o.out).toBe("/tmp/us-out");
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
