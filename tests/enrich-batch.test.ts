import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addFiles, addSource, addSources } from "../src/enrich.js";
import { writeFixtureDossier } from "./dossierfix.js";
import { installFetchMock } from "./fetchmock.js";
import { writeArtifact } from "../src/no-write.js";
import { canonicalizeUrl } from "../src/util.js";
import type { Source } from "../src/types.js";

// A batch ingest must write the three index files ONCE, and the bytes it leaves
// behind must be exactly the bytes N sequential `addSource` calls used to leave.
// That equality is the whole contract of the batching change: same ids, same
// order, same backendsUsed, same sourceCount, same DOSSIER.md — so the twin
// dossier below is the oracle, not a nice-to-have.

// The write gate every dossier write funnels through, spied so a test can count
// how many times sources.json was rewritten during one batch.
vi.mock("../src/no-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/no-write.js")>();
  return { ...actual, writeArtifact: vi.fn(actual.writeArtifact) };
});

// The fetch/extract entry point enrich.ts uses, wrapped so one test can make a
// single URL throw mid-batch (a transport blowing up, not a refusal).
const fetchState = vi.hoisted(() => ({ throwOn: undefined as string | undefined }));
vi.mock("../src/cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cache.js")>();
  return {
    ...actual,
    cachedFetchAndExtract: vi.fn(async (url: string, opts: Parameters<typeof actual.cachedFetchAndExtract>[1], cache: boolean) => {
      if (fetchState.throwOn && url.includes(fetchState.throwOn)) throw new Error(`transport exploded on ${url}`);
      return actual.cachedFetchAndExtract(url, opts, cache);
    }),
  };
});

const writeSpy = vi.mocked(writeArtifact);

// >= 2000 chars of real prose so looksLikeJunkExtraction reads it as content
// rather than as an anti-bot wall — every URL in these batches must be ACCEPTED.
const PAGE = `<title>Batch fixture</title><p>${"Token buckets smooth bursts of traffic without dropping requests outright. ".repeat(40)}</p>`;

const dirs: string[] = [];
function scratch(prefix = "us-batch-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function indexWrites(suffix: string): number {
  return writeSpy.mock.calls.filter((c) => String(c[0]).endsWith(suffix)).length;
}

beforeEach(() => {
  fetchState.throwOn = undefined;
  writeSpy.mockClear();
  // buildSource stamps `new Date().toISOString()` into every source's
  // fetchedAt, which lands in sources.json AND in sources/S#.md — freeze the
  // clock or the byte-identity oracle compares timestamps, not behaviour.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-13T10:30:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const URLS = Array.from({ length: 5 }, (_, i) => `https://batch${i}.example.test/article/${i}`);

describe("addSources — one index write per batch", () => {
  it("writes sources.json once and leaves the same bytes as five sequential addSource calls", async () => {
    const batchDir = scratch();
    const twinDir = scratch();
    writeFixtureDossier(batchDir, 2);
    writeFixtureDossier(twinDir, 2);
    installFetchMock(() => ({ body: PAGE }));

    writeSpy.mockClear();
    const r = await addSources(batchDir, URLS, { question: "rate limiting" });
    expect(r.added).toBe(5);
    expect(indexWrites("sources.json")).toBe(1);
    expect(indexWrites("manifest.json")).toBe(1);
    expect(indexWrites("DOSSIER.md")).toBe(1);

    for (const u of URLS) expect((await addSource(twinDir, u, { question: "rate limiting" })).added).toBe(true);

    for (const f of ["sources.json", "manifest.json", "DOSSIER.md", "sources/S3.md", "sources/S7.md"]) {
      expect(readFileSync(join(batchDir, f), "utf8"), f).toBe(readFileSync(join(twinDir, f), "utf8"));
    }
    const sources = JSON.parse(readFileSync(join(batchDir, "sources.json"), "utf8")) as Source[];
    expect(sources.map((s) => s.id)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7"]);
    expect(JSON.parse(readFileSync(join(batchDir, "manifest.json"), "utf8")).sourceCount).toBe(7);
  });

  // The same URL twice in ONE batch: the second occurrence has to see the id the
  // first one just allocated, even though nothing has been re-read from disk.
  it("refuses a URL repeated inside the same batch with the id allocated earlier in it", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(() => ({ body: PAGE }));

    const r = await addSources(dir, ["https://a.example.test/x", "https://a.example.test/x"], {});
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.results[0]).toMatchObject({ id: "S2", added: true });
    expect(r.results[1]).toEqual({ id: "S2", added: false, note: "already in dossier as S2", url: "https://a.example.test/x" });
    expect(JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[]).toHaveLength(2);
  });

  // A batch that dies halfway must still leave a dossier that reads: the two
  // sources it managed to commit, their extracts, and a manifest that agrees.
  it("flushes what it committed when an item throws mid-batch, then rethrows", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 0);
    installFetchMock(() => ({ body: PAGE }));
    fetchState.throwOn = "batch2";

    await expect(addSources(dir, URLS, {})).rejects.toThrow(/transport exploded/);

    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources.map((s) => s.id)).toEqual(["S1", "S2"]);
    expect(sources.map((s) => s.url)).toEqual([URLS[0], URLS[1]]);
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).sourceCount).toBe(2);
    const dossier = readFileSync(join(dir, "DOSSIER.md"), "utf8");
    expect(dossier).toContain("[S1]");
    expect(dossier).toContain("[S2]");
    expect(dossier).not.toContain("[S3]");
  });

  // Nothing added, nothing written — a batch of URLs already in the dossier
  // must not rewrite the index (and must not touch it at all).
  it("writes nothing at all when a batch adds nothing", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(() => ({ body: PAGE }));
    await addSources(dir, [URLS[0]!], {});

    const before = readFileSync(join(dir, "sources.json"), "utf8");
    const mtime = statSync(join(dir, "sources.json")).mtimeMs;
    writeSpy.mockClear();

    const again = await addSources(dir, [URLS[0]!, URLS[0]!], {});
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(2);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "sources.json"), "utf8")).toBe(before);
    expect(statSync(join(dir, "sources.json")).mtimeMs).toBe(mtime);
  });

  // A dossier that somehow holds two sources on the same canonical url: the
  // `sources.find` this replaced returned the EARLIEST one, so the map has to
  // as well, or a re-ingest starts pointing at a different [S#].
  it("reports the earliest id when two dossier sources share a canonical url", async () => {
    const dir = scratch();
    const sources = writeFixtureDossier(dir, 2);
    sources[0]!.canonicalUrl = canonicalizeUrl(sources[0]!.url);
    sources[1]!.canonicalUrl = sources[0]!.canonicalUrl;
    writeFileSync(join(dir, "sources.json"), JSON.stringify(sources, null, 2));
    installFetchMock(() => ({ body: PAGE }));

    const r = await addSources(dir, [sources[0]!.url], {});
    expect(r.results[0]).toMatchObject({ id: "S1", added: false, note: "already in dossier as S1" });
  });
});

describe("addFiles — lazy dossier read", () => {
  // The refusal happens before anything is read from the dossier, so a bad path
  // is still reported (not thrown) even where no dossier exists at all.
  it("refuses an unreadable path without reading the dossier", async () => {
    const dir = scratch("us-batch-nodossier-");
    const r = await addFiles(dir, [join(dir, "nope.md")], {});
    expect(r.added).toBe(0);
    expect(r.results[0]!.note).toMatch(/not a readable file/);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("writes the index once for a batch of files, byte-identical to sequential adds", async () => {
    const batchDir = scratch();
    const twinDir = scratch();
    const src = scratch("us-batch-files-");
    writeFixtureDossier(batchDir, 1);
    writeFixtureDossier(twinDir, 1);
    const paths = ["a", "b", "c"].map((n) => {
      const p = join(src, `${n}.md`);
      writeFileSync(p, `# Doc ${n}\n\nA local document about queues and locks, number ${n}.\n`);
      return p;
    });

    writeSpy.mockClear();
    expect((await addFiles(batchDir, paths, {})).added).toBe(3);
    expect(indexWrites("sources.json")).toBe(1);

    for (const p of paths) expect((await addFiles(twinDir, [p], {})).added).toBe(1);
    for (const f of ["sources.json", "manifest.json", "DOSSIER.md"]) {
      expect(readFileSync(join(batchDir, f), "utf8"), f).toBe(readFileSync(join(twinDir, f), "utf8"));
    }
  });
});
