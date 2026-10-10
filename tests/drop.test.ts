import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dropSources, formatDropReport } from "../src/drop.js";
import { addSource } from "../src/enrich.js";
import { runCheck } from "../src/check.js";
import { runGather } from "../src/gather.js";
import { gatherReport, main } from "../src/cli.js";
import { callTool } from "../src/mcp/handlers.js";
import { setNoWrite } from "../src/no-write.js";
import { writeFixtureDossier } from "./dossierfix.js";
import { installFetchMock, routes } from "./fetchmock.js";
import type { GatherOptions, Manifest, Source } from "../src/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ULTRASEARCH_NO_WRITE;
  setNoWrite(false); // a `--stdout` run latches the gate for the process
});

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-drop-"));
}
function sourcesOf(dir: string): Source[] {
  return JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
}
function manifestOf(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
}

// A five-source dossier: S2 a gather-flagged wall, S3 an old dossier's cookie
// wall (no flag, only its wording), S4 snippet-only, S5 flagged off-topic.
function dossier(): string {
  const dir = scratch();
  const sources = writeFixtureDossier(dir, 5);
  sources[1]!.wall = true;
  sources[1]!.fullText = false;
  sources[3]!.fullText = false;
  sources[4]!.offTopic = true;
  writeFileSync(join(dir, "sources.json"), JSON.stringify(sources, null, 2));
  writeFileSync(join(dir, "sources/S3.md"), "# S3\nCookies must be enabled. Enable cookies for pubmed.ncbi.nlm.nih.gov and reload this page to continue.\n");
  return dir;
}

async function cli(argv: string[]): Promise<{ out: string; err: string; exitCode: number | undefined }> {
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
  const before = process.exitCode;
  process.exitCode = undefined;
  let exitCode: number | undefined;
  try {
    await main(argv);
    exitCode = process.exitCode as number | undefined;
  } catch (er) {
    const m = /^exit:(\d+)$/.exec((er as Error).message);
    if (!m) throw er;
    exitCode = Number(m[1]);
  } finally {
    o.mockRestore();
    e.mockRestore();
    x.mockRestore();
    process.exitCode = before;
  }
  return { out: out.join(""), err: err.join(""), exitCode };
}

describe("dropSources", () => {
  it("removes sources by id, deletes their extracts and keeps the gaps", () => {
    const dir = dossier();
    const r = dropSources(dir, { ids: ["S2", "s4"] });
    expect(r.dropped.map((d) => d.id)).toEqual(["S2", "S4"]);
    expect(sourcesOf(dir).map((s) => s.id)).toEqual(["S1", "S3", "S5"]);
    expect(existsSync(join(dir, "sources/S2.md"))).toBe(false);
    expect(existsSync(join(dir, "sources/S1.md"))).toBe(true);
    expect(manifestOf(dir)).toMatchObject({ sourceCount: 3, droppedIds: ["S2", "S4"] });
    expect(readFileSync(join(dir, "DOSSIER.md"), "utf8")).toMatch(/\*\*Dropped:\*\* S2, S4/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("never reuses a dropped id, even the highest one", async () => {
    const dir = dossier();
    dropSources(dir, { ids: ["S5"] });
    installFetchMock(routes([["fresh.test", { body: `<p>${"A fresh page long enough to be a document. ".repeat(10)}</p>` }]]));
    const added = await addSource(dir, "https://fresh.test/a", {});
    expect(added.id).toBe("S6");
    dropSources(dir, { ids: ["S6"] });
    expect(manifestOf(dir).droppedIds).toEqual(["S5", "S6"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("selects walls by flag and by wording, snippets, and off-topic sources", () => {
    expect(dropSources(dossier(), { where: "wall", dryRun: true }).dropped).toEqual([
      expect.objectContaining({ id: "S2", reason: "a wall" }),
      expect.objectContaining({ id: "S3", reason: "a cookie wall" }),
    ]);
    expect(dropSources(dossier(), { where: "snippet", dryRun: true }).dropped.map((d) => [d.id, d.reason])).toEqual([
      ["S2", "a wall (snippet only)"],
      ["S4", "snippet only"],
    ]);
    expect(dropSources(dossier(), { where: "offtopic", dryRun: true }).dropped.map((d) => d.id)).toEqual(["S5"]);
  });

  it("finds a no-abstract record of an older dossier under --where snippet", () => {
    const dir = dossier();
    writeFileSync(
      join(dir, "sources/S1.md"),
      "# S1 — Carlevale lens: a case series\n- url: https://doi.org/10.1/x\n- backend: crossref · fetched: 2026-10-10\n\nCarlevale lens: a case series\n\n(no abstract provided by Crossref)\n",
    );
    const r = dropSources(dir, { where: "snippet", dryRun: true });
    expect(r.dropped.map((d) => [d.id, d.reason])).toEqual([
      ["S1", "no abstract (snippet only)"],
      ["S2", "a wall (snippet only)"],
      ["S4", "snippet only"],
    ]);
  });

  it("changes nothing on a dry run, or when nothing matches", () => {
    const dir = dossier();
    const before = readFileSync(join(dir, "sources.json"), "utf8");
    const dry = dropSources(dir, { ids: ["S1"], dryRun: true });
    // What WOULD be left — the audit caught it saying the untouched count.
    expect(dry).toMatchObject({ dryRun: true, remaining: 4 });
    expect(formatDropReport(dry)).toMatch(/would drop 1 source\(s\) → 4 left/);
    const none = dropSources(dir, { ids: ["S99"] });
    expect(none.missing).toEqual(["S99"]);
    expect(formatDropReport(none)).toMatch(/nothing matched[\s\S]*not in this dossier: S99/);
    expect(readFileSync(join(dir, "sources.json"), "utf8")).toBe(before);
    expect(existsSync(join(dir, "DOSSIER.md"))).toBe(false); // the fixture never wrote one, and nothing did since
    rmSync(dir, { recursive: true, force: true });
  });

  it("warns when a report cites a dropped id — and check then fails it as dangling", () => {
    const dir = dossier();
    writeFileSync(join(dir, "REPORT.md"), "# R\nRate limiting caps how many requests a client may make in a window [S1][S2].\n");
    const r = dropSources(dir, { where: "wall" });
    expect(r.citedBy).toEqual([{ file: "REPORT.md", ids: ["S2"] }]);
    expect(formatDropReport(r)).toMatch(/REPORT\.md cites S2 — `check` will fail them as dangling/);
    expect(runCheck(dir).dangling).toEqual(["S2"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to run with nothing to select", () => {
    expect(() => dropSources(dossier(), {})).toThrow(/--id <S#,…> or --where/);
  });
});

describe("drop — CLI and MCP", () => {
  it("drops from the command line and reports each source", async () => {
    const dir = dossier();
    const r = await cli(["drop", "--run", dir, "--where", "wall"]);
    expect(r.exitCode).toBeUndefined();
    expect(r.out).toMatch(/dropped 2 source\(s\) → 3 left/);
    expect(r.out).toMatch(/S3 {2}a cookie wall/);
    const json = await cli(["drop", "--run", dir, "--id", "S1,S77", "--dry-run", "--json"]);
    expect(JSON.parse(json.out)).toMatchObject({ dryRun: true, missing: ["S77"] });
    expect(json.exitCode).toBe(1); // an id that is not there is a mistake worth an exit code
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a bad --where, a missing selector, and --stdout", async () => {
    const dir = dossier();
    expect((await cli(["drop", "--run", dir, "--where", "junk"])).exitCode).toBe(1);
    expect((await cli(["drop", "--run", dir])).err).toMatch(/pass --id <S#,...> or --where/);
    expect((await cli(["drop"])).err).toMatch(/missing --run/);
    const stdout = await cli(["drop", "--run", dir, "--id", "S1", "--stdout"]);
    expect(stdout.exitCode).toBe(2);
    expect(stdout.err).toMatch(/removes sources from a dossier on disk/);
    expect(sourcesOf(dir)).toHaveLength(5);
    rmSync(dir, { recursive: true, force: true });
  });

  it("is mirrored as ultrasearch_drop", async () => {
    const dir = dossier();
    const dry = JSON.parse((await callTool("ultrasearch_drop", { run: dir, where: "offtopic", dry_run: true })).text);
    expect(dry).toMatchObject({ dryRun: true, dropped: [expect.objectContaining({ id: "S5" })] });
    expect(dry.next).toMatch(/without dry_run/);
    const done = JSON.parse((await callTool("ultrasearch_drop", { run: dir, ids: ["S5"] })).text);
    expect(done.next).toMatch(/never reused/);
    writeFileSync(join(dir, "REPORT.md"), "# R\nA claim [S1].\n");
    const cited = JSON.parse((await callTool("ultrasearch_drop", { run: dir, ids: ["S1"] })).text);
    expect(cited.next).toMatch(/rewrite those claims/);
    await expect(callTool("ultrasearch_drop", { run: dir, where: "junk" })).rejects.toThrow(/`where` must be one of/);
    await expect(callTool("ultrasearch_drop", { run: dir })).rejects.toThrow(/Pass `ids` or `where`/);
    process.env.ULTRASEARCH_NO_WRITE = "1";
    await expect(callTool("ultrasearch_drop", { run: dir, ids: ["S2"] })).rejects.toThrow(/cannot run while ULTRASEARCH_NO_WRITE/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gather — off-topic flag", () => {
  function opts(over: Partial<GatherOptions>): GatherOptions {
    return {
      question: "scleral fixation intraocular lens dislocation",
      mode: "topic",
      depth: "standard",
      perSource: 6,
      lang: "en",
      webEngine: "auto",
      excludeDomains: [],
      json: false,
      ...over,
    };
  }
  const onTopic = (n: number) =>
    `<title>Scleral fixation ${n}</title><article><p>${"Scleral fixation of a dislocated intraocular lens: dislocation of the intraocular lens is managed by scleral fixation. ".repeat(6)}</p></article>`;

  it("flags a source matching a stray term of the question, lists it in DOSSIER.md and in the run's report", async () => {
    const dir = scratch();
    installFetchMock(
      routes([
        ["eye-a.test", { body: onTopic(1) }],
        ["eye-b.test", { body: onTopic(2) }],
        ["eye-c.test", { body: onTopic(3) }],
        [
          "arxiv-like.test",
          {
            body: `<title>Attention</title><article><p>${"Transformers attend over tokens; a gravitational lens appears once. Attention heads learn alignments across layers. ".repeat(4)}</p></article>`,
          },
        ],
      ]),
    );
    const options = opts({
      backends: ["claude"],
      webResults: [{ url: "https://eye-a.test/" }, { url: "https://eye-b.test/" }, { url: "https://eye-c.test/" }, { url: "https://arxiv-like.test/" }],
      out: dir,
    });
    const r = await runGather(options);
    const off = r.sources.filter((s) => s.offTopic).map((s) => s.url);
    expect(off).toEqual(["https://arxiv-like.test/"]);
    const offId = r.sources.find((s) => s.offTopic)!.id;
    const md = readFileSync(join(dir, "DOSSIER.md"), "utf8");
    expect(md).toMatch(new RegExp(`🗑 \\*\\*Probably off-topic\\*\\* — ${offId}:`));
    expect(md).toMatch(/ultrasearch drop --run <dir> --where offtopic/);
    expect(gatherReport(r, options).lines.join("\n")).toMatch(new RegExp(`offtopic: ${offId} — probably unrelated; clear them: ultrasearch drop --run`));
    rmSync(dir, { recursive: true, force: true });
  });
});
