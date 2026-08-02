import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { autoRelink, listIssues, relink } from "../src/relink.js";
import { writeFixtureDossier } from "./dossierfix.js";
import { main } from "../src/cli.js";
import type { Source } from "../src/types.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-relink-"));
}
const ENDPOINT = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=34397876&rettype=abstract&retmode=text";

// Give S2 the exact shape the bug produced: a citation pointing at an API
// endpoint, titled by that endpoint because a text payload has no <title>.
function withEndpointSource(dir: string): Source[] {
  const sources = writeFixtureDossier(dir, 2);
  sources[1]!.url = ENDPOINT;
  sources[1]!.canonicalUrl = ENDPOINT;
  sources[1]!.title = ENDPOINT;
  sources[1]!.domain = "eutils.ncbi.nlm.nih.gov";
  writeFileSync(join(dir, "sources.json"), JSON.stringify(sources, null, 2));
  return sources;
}
function read(dir: string): Source[] {
  return JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
}

describe("relink --list", () => {
  it("names a source whose url is an endpoint, and how to fix it", () => {
    const dir = scratch();
    withEndpointSource(dir);
    const issues = listIssues(dir);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ id: "S2", reason: "not-citable" });
    expect(issues[0]!.fix).toContain("relink --run <dir> --id S2");
    rmSync(dir, { recursive: true, force: true });
  });

  it("names a source whose extract is a wall, and tells you to re-fetch it", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    writeFileSync(join(dir, "sources/S1.md"), "# S1\nChecking your browser before accessing pubmed.ncbi.nlm.nih.gov.\n");
    const issues = listIssues(dir);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ id: "S1", reason: "wall" });
    expect(issues[0]!.detail).toContain("anti-bot interstitial");
    expect(issues[0]!.fix).toContain("fetch --url");
    rmSync(dir, { recursive: true, force: true });
  });

  it("says nothing about a healthy dossier", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 3);
    expect(listIssues(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("autoRelink", () => {
  it("repairs every source whose own text proves where it lives", () => {
    const dir = scratch();
    withEndpointSource(dir);
    // The extract is what the endpoint returned — and it names its own document.
    writeFileSync(
      join(dir, "sources/S2.md"),
      "# S2 — endpoint\n- url: x\n- backend: claude\n1. Science. 2012;337:816. doi: 10.1126/science.aad5227.\n\nA programmable endonuclease.\n",
    );
    const { repaired, remaining } = autoRelink(dir);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]).toMatchObject({ id: "S2", to: "https://doi.org/10.1126/science.aad5227" });
    expect(remaining).toEqual([]);
    expect(read(dir)[1]!.meta?.textVia).toBe(ENDPOINT);
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves what it cannot prove for the agent, and says so", () => {
    const dir = scratch();
    withEndpointSource(dir);
    writeFileSync(join(dir, "sources/S2.md"), '# S2 — endpoint\n- url: x\n- backend: claude\n{"count": 3, "results": []}\n');
    const { repaired, remaining } = autoRelink(dir);
    expect(repaired).toEqual([]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.fix).toContain("--id S2 --url");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a duplicate by name instead of merging two ids behind your back", () => {
    const dir = scratch();
    const sources = withEndpointSource(dir);
    sources[0]!.url = "https://doi.org/10.1126/science.aad5227";
    sources[0]!.canonicalUrl = "https://doi.org/10.1126/science.aad5227";
    writeFileSync(join(dir, "sources.json"), JSON.stringify(sources, null, 2));
    writeFileSync(join(dir, "sources/S2.md"), "# S2\n- url: x\n- backend: claude\ndoi: 10.1126/science.aad5227\n");
    const { repaired, remaining } = autoRelink(dir);
    expect(repaired).toEqual([]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ id: "S2", reason: "duplicate" });
    expect(remaining[0]!.detail).toContain("already in the dossier as S1");
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps going past a source it cannot apply, instead of abandoning the rest", () => {
    const dir = scratch();
    const sources = writeFixtureDossier(dir, 3);
    // S1 is an unrepairable endpoint (its payload names nothing); S2 and S3 are
    // endpoints whose text names a distinct document each.
    for (const [i, body] of [
      [0, '{"count": 0}'],
      [1, "doi: 10.1000/aaa"],
      [2, "doi: 10.1000/bbb"],
    ] as [number, string][]) {
      sources[i]!.url = `https://api.test/v1/rec/${i}?format=json`;
      sources[i]!.canonicalUrl = sources[i]!.url;
      writeFileSync(join(dir, `sources/S${i + 1}.md`), `# S${i + 1}\n- url: x\n- backend: claude\n${body}\n`);
    }
    writeFileSync(join(dir, "sources.json"), JSON.stringify(sources, null, 2));
    const { repaired, remaining } = autoRelink(dir);
    expect(repaired.map((r) => r.id)).toEqual(["S2", "S3"]); // S1's refusal didn't stop them
    expect(remaining.map((i) => i.id)).toEqual(["S1"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("relink", () => {
  it("repoints the citation, refreshes the derived fields and keeps the provenance", () => {
    const dir = scratch();
    withEndpointSource(dir);
    const r = relink(dir, "S2", "https://pubmed.ncbi.nlm.nih.gov/34397876/");
    expect(r).toMatchObject({ id: "S2", relinked: true, from: ENDPOINT });

    const s2 = read(dir)[1]!;
    expect(s2.url).toBe("https://pubmed.ncbi.nlm.nih.gov/34397876/");
    expect(s2.canonicalUrl).toBe("https://pubmed.ncbi.nlm.nih.gov/34397876");
    expect(s2.domain).toBe("pubmed.ncbi.nlm.nih.gov");
    expect(s2.title).toBe("S2"); // named by its own text, not by a url
    expect(s2.meta?.textVia).toBe(ENDPOINT); // where the text actually came from survives
    // The extract header carries the url, so it is rewritten too.
    expect(readFileSync(join(dir, s2.extract), "utf8")).toContain("- url: https://pubmed.ncbi.nlm.nih.gov/34397876/");
    expect(listIssues(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("takes a title when you have a better one, and leaves a real title alone", () => {
    const dir = scratch();
    withEndpointSource(dir);
    relink(dir, "S2", "https://pubmed.ncbi.nlm.nih.gov/34397876/", { title: "Comparison of two scleral fixation techniques" });
    expect(read(dir)[1]!.title).toBe("Comparison of two scleral fixation techniques");

    const other = scratch();
    writeFixtureDossier(other, 2); // S2's title is "Source S2", not its url
    relink(other, "S2", "https://journal.test/article/9");
    expect(read(other)[1]!.title).toBe("Source S2");
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it("refuses a url no reader can open, an unknown id, a no-op and a collision", () => {
    const dir = scratch();
    withEndpointSource(dir);
    expect(relink(dir, "S2", "https://api.crossref.org/works/10.1/x").note).toMatch(/not a citable page url/);
    expect(relink(dir, "S9", "https://ok.test/a").note).toMatch(/not in this dossier/);
    expect(relink(dir, "S2", ENDPOINT).note).toMatch(/not a citable page url/);
    expect(relink(dir, "S2", "https://src.test/s1").note).toMatch(/S1 already cites/);
    expect(read(dir)[1]!.url).toBe(ENDPOINT); // untouched by every refusal
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op when the source already points there", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    expect(relink(dir, "S1", "https://src.test/s1").note).toMatch(/already points at/);
    rmSync(dir, { recursive: true, force: true });
  });
});

// The CLI surface, driven in-process like cli-fetch.test.ts.
async function runCli(argv: string[]): Promise<{ out: string; err: string; exit?: number }> {
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

describe("main() — relink", () => {
  it("lists issues as JSON, repairs one, then reports a clean dossier", async () => {
    const dir = scratch();
    withEndpointSource(dir);
    const listed = await runCli(["relink", "--run", dir, "--list", "--json"]);
    expect(JSON.parse(listed.out)[0]).toMatchObject({ id: "S2", reason: "not-citable" });

    const fixed = await runCli(["relink", "--run", dir, "--id", "S2", "--url", "https://pubmed.ncbi.nlm.nih.gov/34397876/"]);
    expect(fixed.exit).toBeUndefined();
    expect(fixed.err).toMatch(/S2 now cites/);

    const clean = await runCli(["relink", "--run", dir, "--list"]);
    expect(clean.out).toMatch(/nothing to repair/);

    // Bare `relink` is the automatic pass: nothing left to prove here.
    const auto = await runCli(["relink", "--run", dir]);
    expect(auto.out).toMatch(/repaired 0 source\(s\); nothing left to fix/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 1 on a refusal and errors without --run", async () => {
    const dir = scratch();
    withEndpointSource(dir);
    const bad = await runCli(["relink", "--run", dir, "--id", "S2", "--url", "https://api.crossref.org/works/10.1/x"]);
    expect(bad.exit).toBe(1);
    expect(bad.err).toMatch(/not a citable page url/);
    expect((await runCli(["relink"])).exit).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
