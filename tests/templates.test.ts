import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";
import { runCheck } from "../src/check.js";
import { citedSourceIds, unitsOfFile } from "../src/claims.js";
import { EXTRA_TEMPLATES, hasOpenQuestions, setDossierTemplate, templateFor } from "../src/templates.js";
import { getMode } from "../src/modes/registry.js";
import { callTool } from "../src/mcp/handlers.js";
import { ALL_TEMPLATES, type Manifest } from "../src/types.js";
import { renderHtml } from "../src/render.js";

afterEach(() => vi.unstubAllGlobals());

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
    if (!m) throw er;
    exit = Number(m[1]);
  } finally {
    o.mockRestore();
    e.mockRestore();
    x.mockRestore();
  }
  return { out: out.join(""), err: err.join(""), exit };
}

const manifest = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));

describe("report templates", () => {
  it("resolves every template name: a mode's own, or one no mode owns", () => {
    for (const t of ALL_TEMPLATES) expect(templateFor({ mode: "topic", template: t })).toMatch(/^## /);
    expect(templateFor({ mode: "research" })).toBe(getMode("research").template);
    expect(templateFor({ mode: "topic", template: "clinical" })).toBe(getMode("clinical").template);
    expect(templateFor({ mode: "topic", template: "verification" })).toBe(EXTRA_TEMPLATES.verification.template);
    expect(EXTRA_TEMPLATES.verification.template).toContain("## Reference-by-reference table");
    expect(EXTRA_TEMPLATES.verification.template).toContain("## Open questions");
  });

  it("recognises an Open questions section in English or French", () => {
    expect(hasOpenQuestions("## Open questions / contradictions\n")).toBe(true);
    expect(hasOpenQuestions("### Questions ouvertes\n")).toBe(true);
    expect(hasOpenQuestions("## Contradictions\n")).toBe(true);
    expect(hasOpenQuestions("Open questions are mentioned in prose only.\n## Findings\n")).toBe(false);
  });

  it("gather --template writes the dossier to that template; ingest --template switches it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-tpl-"));
    try {
      await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--template", "verification", "--out", dir]);
      expect(manifest(dir).template).toBe("verification");
      expect(readFileSync(join(dir, "DOSSIER.md"), "utf8")).toContain("## Report template (verification)\n\n```markdown\n## Verdict");
      const r = await run(["ingest", "--run", dir, "--template", "clinical"]);
      expect(r.exit).toBeUndefined();
      expect(r.err).toMatch(/now asks for the clinical template/);
      expect(readFileSync(join(dir, "DOSSIER.md"), "utf8")).toContain("## Clinical question (PICO)");
      expect((await run(["ingest", "--run", dir, "--template", "nope"])).exit).toBe(1);
      expect((await run(["ingest", "--run", join(dir, "missing"), "--template", "topic"])).exit).toBe(1);
      expect((await run(["ingest", "--run", dir])).err).toMatch(/--template <t>/);
      // The mode's own template is not recorded as an override.
      const own = mkdtempSync(join(tmpdir(), "us-tpl-"));
      await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--mode", "topic", "--template", "topic", "--out", own]);
      expect(manifest(own).template).toBeUndefined();
      rmSync(own, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the MCP gather and ingest take a template too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-tpl-"));
    try {
      await callTool("ultrasearch_gather", { question: "rate limiting", backends: ["fixture"], template: "verification", out: dir });
      expect(manifest(dir).template).toBe("verification");
      const r = JSON.parse((await callTool("ultrasearch_ingest", { run: dir, template: "learn" })).text);
      expect(r.template).toBe("learn");
      expect(manifest(dir).template).toBe("learn");
      await expect(callTool("ultrasearch_gather", { question: "x", template: "nope" })).rejects.toThrow(/template/);
      setDossierTemplate(dir, "research");
      expect(manifest(dir).template).toBe("research");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("check warns — never fails — when REPORT.md has no Open questions section; render hoists a French one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-tpl-"));
    try {
      await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--out", dir]);
      writeFileSync(join(dir, "REPORT.md"), "## Verdict\n\nRate limiting caps how many requests a client may make [S1].\n");
      let r = runCheck(dir);
      expect(r.ok).toBe(true);
      expect(r.warnings.join(" ")).toMatch(/no "Open questions" section/);
      writeFileSync(
        join(dir, "REPORT.md"),
        "## Verdict\n\nRate limiting caps how many requests a client may make [S1].\n\n## Questions ouvertes\n\n- Rien [M].\n",
      );
      r = runCheck(dir);
      expect(r.warnings.join(" ")).not.toMatch(/no "Open questions" section/);
      expect(renderHtml(dir)).toContain("Jump to the section");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the References (see refs.bib) appendix", () => {
  const REPORT = [
    "## Findings",
    "",
    "Token buckets refill at a fixed rate and allow short bursts [S1].",
    "",
    "## References (see refs.bib)",
    "",
    "The BibTeX file lists every scholarly source cited in this report body.",
    "- [S2] Some paper",
    "",
    "## Références (voir refs.bib)",
    "",
    "Toutes les références citées dans le corps du rapport sont listées ici.",
  ].join("\n");

  it("is masked like a bare References heading: its pointer is no claim, its listing no citation", () => {
    const units = unitsOfFile(REPORT).flatMap((u) => (u.kind === "text" ? [u.text] : u.items));
    expect(units.join(" ")).not.toMatch(/BibTeX file lists|Toutes les références/);
    expect([...citedSourceIds(REPORT)]).toEqual(["S1"]);
  });
});
