import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { autoRelink, listIssues, relink } from "../src/relink.js";
import { writeFixtureDossier } from "./dossierfix.js";
import { writeArtifact } from "../src/no-write.js";
import type { Source } from "../src/types.js";

// `autoRelink` repairs in memory and writes the index ONCE. Two things have to
// stay true through that change, and both are asserted here against an oracle
// rather than against a description:
//
//   1. the RESULT — `{ repaired, remaining }` — is what the re-listing loop
//      returned, down to every note/detail/fix string and the order;
//   2. the BYTES left on disk are what N sequential `relink` calls left, which
//      is why each test compares a batch dossier against a twin repaired one
//      call at a time.

// The write gate every dossier write funnels through, spied so a test can count
// how many times sources.json was rewritten during one pass.
vi.mock("../src/no-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/no-write.js")>();
  return { ...actual, writeArtifact: vi.fn(actual.writeArtifact) };
});

const writeSpy = vi.mocked(writeArtifact);

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "us-relink-batch-"));
  dirs.push(d);
  return d;
}

function indexWrites(suffix: string): number {
  return writeSpy.mock.calls.filter((c) => String(c[0]).endsWith(suffix)).length;
}

// n sources whose url is a machine endpoint (the shape `relink` repairs) and
// whose extract is `bodies[i]` — the text that does or does not name a page.
function endpointDossier(dir: string, bodies: string[]): Source[] {
  const sources = writeFixtureDossier(dir, bodies.length);
  for (const [i, body] of bodies.entries()) {
    const url = `https://api.test/v1/rec/${i}?format=json`;
    sources[i]!.url = url;
    sources[i]!.canonicalUrl = url;
    sources[i]!.domain = "api.test";
    sources[i]!.title = url; // a payload has no <title>: the url stands in
    writeFileSync(join(dir, sources[i]!.extract), `# S${i + 1} — endpoint\n- url: x\n- backend: claude\n${body}\n`);
  }
  writeFileSync(join(dir, "sources.json"), JSON.stringify(sources, null, 2));
  return sources;
}

beforeEach(() => {
  writeSpy.mockClear();
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("autoRelink — repaired in memory, index written once", () => {
  // The invariant the old per-round re-listing existed for: repairing S1 makes
  // the page it now cites part of the dossier, which turns S2 — a DIFFERENT
  // endpoint whose payload names the SAME document — into a duplicate. The
  // in-memory state has to see that, so S2 is reported, never relinked.
  it("turns a later twin into a duplicate of the source it just repaired", () => {
    const dir = scratch();
    endpointDossier(dir, ["doi: 10.1000/twin\n\nBoth endpoints return the same record.", "doi: 10.1000/twin\n\nBoth endpoints return the same record."]);

    // Captured from the re-listing implementation: the whole result, verbatim.
    expect(autoRelink(dir)).toEqual({
      repaired: [{ id: "S1", relinked: true, from: "https://api.test/v1/rec/0?format=json", to: "https://doi.org/10.1000/twin" }],
      remaining: [
        {
          id: "S2",
          url: "https://api.test/v1/rec/1?format=json",
          reason: "duplicate",
          detail: "the url is a machine endpoint, and the document it names is already in the dossier as S1",
          derived: "https://doi.org/10.1000/twin",
          fix: "cite S1 instead and drop S2's citations, or relink S2 to a different page",
        },
      ],
    });
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources[0]!.url).toBe("https://doi.org/10.1000/twin");
    expect(sources[1]!.url).toBe("https://api.test/v1/rec/1?format=json"); // untouched
  });

  it("writes the index once for three repairs and leaves the bytes three sequential relinks leave", () => {
    const bodies = ["doi: 10.1000/aaa", "doi: 10.1000/bbb", "doi: 10.1000/ccc"];
    const batchDir = scratch();
    const twinDir = scratch();
    endpointDossier(batchDir, bodies);
    endpointDossier(twinDir, bodies);

    writeSpy.mockClear();
    const { repaired, remaining } = autoRelink(batchDir);
    expect(repaired.map((r) => r.id)).toEqual(["S1", "S2", "S3"]);
    expect(remaining).toEqual([]);
    expect(indexWrites("sources.json")).toBe(1);
    expect(indexWrites("manifest.json")).toBe(1);
    expect(indexWrites("DOSSIER.md")).toBe(1);
    // Each repaired extract is still written as it happens — the header carries
    // the new url, and batching the index must not batch those.
    for (const id of ["S1", "S2", "S3"]) expect(indexWrites(`${id}.md`)).toBe(1);

    // The oracle: the same three repairs, one `relink` call at a time.
    for (const [i, doi] of ["10.1000/aaa", "10.1000/bbb", "10.1000/ccc"].entries()) {
      expect(relink(twinDir, `S${i + 1}`, `https://doi.org/${doi}`).relinked).toBe(true);
    }
    for (const f of ["sources.json", "manifest.json", "DOSSIER.md", "sources/S1.md", "sources/S2.md", "sources/S3.md"]) {
      expect(readFileSync(join(batchDir, f), "utf8"), f).toBe(readFileSync(join(twinDir, f), "utf8"));
    }
  });

  it("writes nothing at all when there is nothing it can prove", () => {
    const dir = scratch();
    endpointDossier(dir, ['{"count": 0, "results": []}']);
    const before = readFileSync(join(dir, "sources.json"), "utf8");

    writeSpy.mockClear();
    const { repaired, remaining } = autoRelink(dir);
    expect(repaired).toEqual([]);
    expect(remaining.map((i) => i.id)).toEqual(["S1"]);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "sources.json"), "utf8")).toBe(before);
  });

  // A legacy/hand-edited dossier can hold two sources on ONE canonical url.
  // Repairing the second must not drop the first one's claim on it — the
  // canonical index has to stay what a scan of the sources would have said.
  it("keeps the other holder of a canonical url when it repairs a source that shares it", () => {
    const dir = scratch();
    const sources = endpointDossier(dir, ["doi: 10.1000/aaa", "doi: 10.1000/bbb", "doi: 10.1000/ccc"]);
    sources[0]!.url = "https://src.test/dup";
    sources[0]!.canonicalUrl = "https://src.test/dup";
    sources[0]!.title = "Source S1";
    sources[1]!.canonicalUrl = "https://src.test/dup"; // still an endpoint url, canonically twinned with S1
    writeFileSync(join(dir, "sources.json"), JSON.stringify(sources, null, 2));

    const { repaired } = autoRelink(dir);
    expect(repaired.map((r) => r.id)).toEqual(["S2", "S3"]); // S1 already cites a page
    // S1 never moved, so nothing else may claim its url.
    expect(relink(dir, "S3", "https://src.test/dup").note).toMatch(/^S1 already cites/);
  });

  // `remaining` is computed from the in-memory text cache; a fresh `listIssues`
  // reads the extracts back off disk. They must agree — including for a source
  // that was JUST repaired and whose text is still a wall, which is the one
  // entry that would drift if the cache went stale after a rewrite.
  it("reports exactly what a fresh listIssues reports, repaired sources included", () => {
    const dir = scratch();
    endpointDossier(dir, ["doi: 10.1000/aaa", '{"count": 0, "results": []}', "Checking your browser before accessing example.test.\ndoi: 10.1000/ccc"]);

    const { repaired, remaining } = autoRelink(dir);
    expect(repaired.map((r) => r.id)).toEqual(["S1", "S3"]);
    expect(remaining.map((i) => `${i.id}:${i.reason}`)).toEqual(["S2:not-citable", "S3:wall"]);
    expect(remaining[0]!.evidence?.excerpt).toBe('{"count": 0, "results": []}');
    expect(remaining).toEqual(listIssues(dir));
  });
});
