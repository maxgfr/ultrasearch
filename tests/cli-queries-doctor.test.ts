import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main, readWebResultsPayload } from "../src/cli.js";
import { describeWebSearchLane } from "../src/services.js";
import { parseWebResults } from "../src/backends/websearch.js";

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

afterEach(() => vi.unstubAllGlobals());

describe("main() — queries (the WebSearch worklist)", () => {
  it("prints the sweep size, the angles and the follow-up command", async () => {
    const r = await run(["queries", "--q", "what is rate limiting", "--mode", "topic", "--depth", "standard"]);
    expect(r.exit).toBeUndefined();
    expect(r.out).toMatch(/Run 4 DISTINCT WebSearch queries/);
    expect(r.out).toMatch(/gather --q "what is rate limiting"/);
    expect(r.out).toMatch(/--web-results/);
  });

  it("emits the same plan as JSON", async () => {
    const r = await run(["queries", "--q", "TypeError undefined", "--mode", "bug", "--depth", "deep", "--lang", "fr", "--json"]);
    const plan = JSON.parse(r.out) as { target: number; angles: string[]; lang: string; planned: string[] };
    expect(plan.target).toBe(8);
    expect(plan.lang).toBe("fr");
    expect(plan.angles.length).toBeGreaterThan(0);
    expect(plan.planned.length).toBeGreaterThan(0);
  });

  it("writes nothing, so it is safe in a read-only phase", async () => {
    const r = await run(["queries", "--q", "anything", "--stdout"]);
    expect(r.exit).toBeUndefined();
    expect(r.out).toMatch(/DISTINCT WebSearch queries/);
  });

  it("refuses a missing question and an unknown mode", async () => {
    expect((await run(["queries"])).exit).toBe(1);
    expect((await run(["queries", "--q", "x", "--mode", "nope"])).exit).toBe(1);
  });
});

describe("main() — doctor", () => {
  it("names the WebSearch lane as the primary engine, unprobeable from here", async () => {
    const r = await run(["doctor", "--json", "--searxng", "off", "--firecrawl", "off"]);
    const rows = JSON.parse(r.out) as { name: string; detail: string }[];
    expect(rows[0]!.name).toBe("websearch");
    expect(rows[0]!.detail).toMatch(/PRIMARY engine/);
  });

  it("with --run, says whether THAT dossier actually had a lane", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-doctor-"));
    try {
      await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--out", dir]);
      const r = await run(["doctor", "--run", dir, "--json", "--searxng", "off", "--firecrawl", "off"]);
      const rows = JSON.parse(r.out) as { name: string; ok: boolean; detail: string }[];
      expect(rows[0]!.name).toBe("websearch");
      expect(rows[0]!.ok).toBe(false);
      expect(rows[0]!.detail).toMatch(/NO lane/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on a --run that is not a dossier", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-doctor-empty-"));
    try {
      expect((await run(["doctor", "--run", dir])).exit).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints the human table too", async () => {
    const r = await run(["doctor", "--searxng", "off", "--firecrawl", "off"]);
    expect(r.out).toMatch(/websearch/);
  });
});

describe("describeWebSearchLane", () => {
  it("reports a run that used its lane, rejections included", () => {
    const row = describeWebSearchLane({ webSearch: { supplied: 12, rejected: 2, kept: 9 }, searchProfile: "light" });
    expect(row.ok).toBe(true);
    expect(row.detail).toMatch(/12 hit\(s\) supplied → 9 kept \(2 rejected\), --search light/);
  });

  it("flags a run that had none — the failure that is invisible everywhere else", () => {
    expect(describeWebSearchLane({ webSearch: { supplied: 0, rejected: 0, kept: 0 } }).ok).toBe(false);
    expect(describeWebSearchLane({}).ok).toBe(false);
  });
});

describe("readWebResultsPayload", () => {
  it("reads a file, and stdin on '-'", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-payload-"));
    try {
      const f = join(dir, "hits.json");
      writeFileSync(f, '[{"url":"https://a.test/x"}]');
      expect(parseWebResults(readWebResultsPayload(f)).hits).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loudly on a path that does not exist", () => {
    expect(() => readWebResultsPayload(join(tmpdir(), "definitely-not-here-us.json"))).toThrow();
  });
});

describe("gather --web-results — the CLI seam", () => {
  it("refuses a payload that parsed to nothing, instead of silently falling back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-lane-empty-"));
    try {
      const f = join(dir, "hits.json");
      writeFileSync(f, JSON.stringify([{ title: "no url anywhere" }]));
      const r = await run(["gather", "--q", "x", "--web-results", f, "--out", dir]);
      expect(r.exit).toBe(1);
      expect(r.err).toMatch(/yielded no usable hit/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces the parser's notes to stderr so a malformed payload is visible", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-lane-notes-"));
    try {
      const f = join(dir, "hits.txt");
      writeFileSync(f, "https://a.test/x\nnot-a-url\n");
      await run(["gather", "--q", "x", "--web-results", f, "--out", dir, "--backends", "fixture"]).catch(() => undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown --search value", async () => {
    expect((await run(["gather", "--q", "x", "--search", "medium"])).exit).toBe(1);
  });
});
