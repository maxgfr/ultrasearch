import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";
import { installFetchMock } from "./fetchmock.js";
import type { Source } from "../src/types.js";

// Same in-process capture harness as cli-fetch.test.ts, so V8 coverage sees the
// ingest branches (which need a mocked network).
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

const page = (n: string) =>
  `<html><head><title>${n}</title></head><body><main>${`Rate limiting caps how many requests a client may make in a window. ${n} `.repeat(20)}</main></body></html>`;

afterEach(() => vi.unstubAllGlobals());

describe("main() — ingest (the batch that replaces N subprocesses)", () => {
  it("adds every URL of a --web-results payload in ONE process, with stable ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-ingest-"));
    try {
      await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--out", dir]);
      installFetchMock((url) => (url.includes(".test") ? { body: page(url), contentType: "text/html" } : undefined));

      const hits = join(dir, "websearch.json");
      writeFileSync(
        hits,
        JSON.stringify([{ url: "https://a.test/one", title: "One" }, { url: "https://b.test/two", title: "Two" }, { url: "https://c.test/three" }]),
      );

      const r = await run(["ingest", "--run", dir, "--web-results", hits, "--q", "rate limiting"]);
      expect(r.exit).toBeUndefined();
      expect(r.err).toMatch(/ingested 3 source\(s\), skipped 0 of 3/);

      const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
      const added = sources.filter((s) => s.backend === "claude");
      expect(added).toHaveLength(3);
      // Ids are contiguous and unique — the property the sequential ingest
      // exists to protect. A concurrent one would let two sources claim the
      // same S#, leaving a citation that resolves to the wrong page.
      expect(new Set(sources.map((s) => s.id)).size).toBe(sources.length);
      expect(added.map((s) => s.title)).toEqual(["One", "Two", `https://c.test/three`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports one outcome per URL — refusals and duplicates included, never dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-ingest-mixed-"));
    const prev = process.env.ULTRASEARCH_NO_WAYBACK;
    process.env.ULTRASEARCH_NO_WAYBACK = "1";
    try {
      await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--out", dir]);
      installFetchMock((url) => {
        if (url.includes("good.test")) return { body: page("good"), contentType: "text/html" };
        if (url.includes("dead.test")) return { status: 404, body: "" };
        return undefined;
      });

      const r = await run(["ingest", "--run", dir, "--urls", "https://good.test/a,https://dead.test/b,https://good.test/a", "--json"]);
      expect(r.exit).toBeUndefined();
      const parsed = JSON.parse(r.out) as { added: number; skipped: number; results: { url: string; added: boolean; note?: string }[] };
      expect(parsed.results).toHaveLength(3);
      expect(parsed.added).toBe(1);
      expect(parsed.skipped).toBe(2);
      expect(parsed.results[1]!.added).toBe(false);
      expect(parsed.results[2]!.note).toMatch(/already in dossier/i);
    } finally {
      if (prev === undefined) delete process.env.ULTRASEARCH_NO_WAYBACK;
      else process.env.ULTRASEARCH_NO_WAYBACK = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 when NOTHING was added — a failed acquisition is not a quiet success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-ingest-empty-"));
    const prev = process.env.ULTRASEARCH_NO_WAYBACK;
    process.env.ULTRASEARCH_NO_WAYBACK = "1";
    try {
      await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--out", dir]);
      installFetchMock(() => ({ status: 404, body: "" }));
      const r = await run(["ingest", "--run", dir, "--urls", "https://dead.test/a"]);
      expect(r.exit).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.ULTRASEARCH_NO_WAYBACK;
      else process.env.ULTRASEARCH_NO_WAYBACK = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to run under --stdout, like every other command whose product is a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-ingest-nw-"));
    try {
      const r = await run(["ingest", "--run", dir, "--urls", "https://a.test/x", "--stdout"]);
      expect(process.exitCode).toBe(2);
      expect(r.err).toMatch(/cannot run without writing/);
      process.exitCode = 0;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loudly on a missing target or an empty payload, instead of doing nothing quietly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-ingest-bad-"));
    try {
      expect((await run(["ingest", "--urls", "https://a.test/x"])).exit).toBe(1);
      expect((await run(["ingest", "--run", dir])).err).toMatch(/missing --web-results/);

      const empty = join(dir, "empty.json");
      writeFileSync(empty, JSON.stringify([{ title: "no url here" }]));
      const r = await run(["ingest", "--run", dir, "--web-results", empty]);
      expect(r.exit).toBe(1);
      expect(r.err).toMatch(/yielded no usable hit/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("main() — gather --web-results (the lane, end to end)", () => {
  it("drives discovery from the agent's hits, with no scraped cascade at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-lane-"));
    try {
      installFetchMock((url) => {
        // Any call to a scraped discovery engine is a failure of the premise:
        // --search light must not touch them.
        if (/duckduckgo|mojeek|marginalia|searx/.test(url)) throw new Error(`light profile queried a discovery engine: ${url}`);
        if (url.includes(".test")) return { body: page(url), contentType: "text/html" };
        return undefined;
      });
      const hits = join(tmpdir(), `us-lane-hits-${Date.now()}.json`);
      writeFileSync(
        hits,
        JSON.stringify([
          { url: "https://a.test/one", title: "One" },
          { url: "https://b.test/two", title: "Two" },
        ]),
      );

      const r = await run(["gather", "--q", "rate limiting", "--out", dir, "--web-results", hits, "--backends", "claude"]);
      expect(r.exit).toBeUndefined();
      expect(r.err).toMatch(/websearch: 2 hit\(s\) supplied/);

      const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
      expect(sources.length).toBeGreaterThan(0);
      expect(sources.every((s) => s.backend === "claude")).toBe(true);
      // Hydrated, not trusted-on-faith: the lane supplies URLs, the engine
      // still reads the pages.
      expect(readFileSync(join(dir, sources[0]!.extract), "utf8")).toMatch(/Rate limiting caps/);
      rmSync(hits, { force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says so, loudly, when a run had no WebSearch lane", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-nolane-"));
    try {
      const r = await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--out", dir]);
      expect(r.err).toMatch(/websearch: none supplied/);
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { webSearch: { supplied: number } };
      expect(manifest.webSearch.supplied).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
