import { describe, expect, it } from "vitest";
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderHtml, mdToHtml, buildReportMarkdown, writeReportMarkdown } from "../src/render.js";
import { writeDossier } from "../src/dossier.js";
import { runVerify, applyVerdicts } from "../src/verify.js";
import { writeFixtureDossier } from "./dossierfix.js";
import type { Manifest, RawSource } from "../src/types.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-render-"));
}

function baseManifest(over: Partial<Manifest> = {}): Manifest {
  return {
    version: "1.2.0", question: "rate limiting", mode: "topic", depth: "deep", lang: "en",
    backends: ["duckduckgo"], backendsUsed: ["duckduckgo"], sourceCount: 0, maxSources: 60,
    builtAt: "2026-06-14T10:00:00.000Z", slug: "topic-rl", tiers: ["SUMMARY.md", "REPORT.md", "FULL.md"],
    extras: [], notes: [], timings: {}, ...over,
  };
}

// Fill the worklist's verdicts by sourceId and apply them.
function applyBySource(dir: string, map: Record<string, string>): void {
  const todo = JSON.parse(readFileSync(join(dir, "VERIFY.todo.json"), "utf8"));
  const pairs = todo.pairs.map((p: any) => ({ ...p, verdict: map[p.sourceId] ?? "supported", note: "" }));
  writeFileSync(join(dir, "verdicts.json"), JSON.stringify({ pairs }));
  applyVerdicts(dir, join(dir, "verdicts.json"));
}

describe("mdToHtml", () => {
  it("renders headings, lists, tables and links and collects h2 headings", () => {
    const { html, headings } = mdToHtml(
      `## Section One\nSome **bold** and \`code\`.\n\n- item one\n- item two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n`,
      "report",
    );
    expect(html).toContain('<h2 id="report-section-one">Section One</h2>');
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<ul><li>item one</li>");
    expect(html).toContain("<table>");
    expect(headings.find((h) => h.level === 2)?.text).toBe("Section One");
  });

  it("turns [S#] into a citation anchor and [M] into a badge", () => {
    const { html } = mdToHtml("A claim [S3] and a hint [M].", "full");
    expect(html).toContain('<a class="cite" href="#src-S3"');
    expect(html).toContain('<sup class="mhint"');
  });

  it("renders a model-hint blockquote as a callout", () => {
    const { html } = mdToHtml("> [model-hint] token buckets are common", "report");
    expect(html).toContain('class="model-hint"');
    expect(html).toContain("model hint");
  });
});

describe("renderHtml", () => {
  it("produces a self-contained page with TOC, citations and sources, no external assets", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    writeFileSync(join(dir, "REPORT.md"), `# Rate limiting\n## How it works\nA token bucket refills at a steady rate [S1] and bursts up to its size [S2].`);
    const html = renderHtml(dir);

    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toMatch(/<link\s+href=/i);
    expect(html).toContain("<nav>");
    expect(html).toContain('href="#src-S1"');
    expect(html).toContain('id="src-S1"');
    expect(html).toContain("Rate limiting");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("buildReportMarkdown / writeReportMarkdown", () => {
  it("assembles a title, the tiers, and a Sources appendix into one markdown doc", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    writeFileSync(join(dir, "SUMMARY.md"), "TL;DR about rate limiting [S1].");
    writeFileSync(join(dir, "REPORT.md"), "# Rate limiting\n## How it works\nToken bucket refills [S1].");
    const md = buildReportMarkdown(dir);
    expect(md).toMatch(/^# /); // a title heading
    expect(md).toContain("## Summary");
    expect(md).toContain("## Report");
    expect(md).toContain("Token bucket refills [S1].");
    expect(md).toContain("## Sources");
    expect(md).toContain("**[S1]**");
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes index.md to the dossier directory (not report.md — avoids clobbering REPORT.md)", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    const path = writeReportMarkdown(dir);
    expect(path).toMatch(/index\.md$/);
    expect(readFileSync(path, "utf8")).toContain("## Sources");
    rmSync(dir, { recursive: true, force: true });
  });

  it("includes a verification table when VERIFY.json exists", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    writeFileSync(
      join(dir, "REPORT.md"),
      "# R\n## A\nA grounded claim about token buckets and request bursts here [S1].",
    );
    runVerify(dir);
    applyBySource(dir, { S1: "supported" });
    const md = buildReportMarkdown(dir);
    expect(md).toContain("## Verification");
    expect(md).toMatch(/\| Claim \| Source \| Verdict \| Note \|/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("renderHtml — deep-research enrichment", () => {
  it("tints citations by verdict and renders a verification section when VERIFY.json exists", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    writeFileSync(
      join(dir, "REPORT.md"),
      "# R\n## A\nA grounded claim about token buckets and request bursts here [S1].\n## B\nAnother grounded claim about leaky buckets and steady rates here [S2].",
    );
    runVerify(dir);
    applyBySource(dir, { S1: "supported", S2: "refuted" });
    const html = renderHtml(dir);
    expect(html).toContain('id="verification"');
    expect(html).toContain('class="cite v-supported" href="#src-S1"');
    expect(html).toContain('class="cite v-refuted" href="#src-S2"');
    expect(html).toMatch(/vbadge v-refuted/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders a Contradictions panel when a claim's cited sources disagree", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    writeFileSync(
      join(dir, "REPORT.md"),
      "# R\n## A\nA grounded claim about token buckets and bursts citing both sources here [S1][S2].",
    );
    runVerify(dir);
    applyBySource(dir, { S1: "supported", S2: "refuted" });
    const html = renderHtml(dir);
    expect(html).toContain('id="contradictions"');
    expect(html).toContain("Contradictions");
    // the top callout points at the data-driven panel
    expect(html).toContain('href="#contradictions"');
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders the sub-question tree from a merge manifest + provenance", () => {
    const dir = scratch();
    const raws: RawSource[] = [
      { url: "https://a.test/1", title: "A", backend: "duckduckgo", score: 1, snippet: "a", text: "alpha", meta: { provenance: [{ subQuestion: "facet alpha", runDir: "r1" }] } },
      { url: "https://b.test/2", title: "B", backend: "duckduckgo", score: 0.5, snippet: "b", text: "beta", meta: { provenance: [{ subQuestion: "facet beta", runDir: "r2" }] } },
    ];
    writeDossier(
      dir,
      raws,
      baseManifest({ subQuestions: [{ id: "Q1", question: "facet alpha" }, { id: "Q2", question: "facet beta" }] }),
      "## TL;DR\n## Sources",
    );
    writeFileSync(join(dir, "REPORT.md"), "# R\nA grounded claim about the first facet here [S1].");
    const html = renderHtml(dir);
    expect(html).toContain('id="subquestions"');
    expect(html).toContain("facet alpha");
    expect(html).toContain("facet beta");
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders citations exactly as before when there is no VERIFY.json (back-compat)", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    writeFileSync(join(dir, "REPORT.md"), "# R\nA grounded factual claim about request windows here [S1].");
    const html = renderHtml(dir);
    expect(html).toContain('<a class="cite" href="#src-S1"');
    expect(html).not.toContain('class="cite v-'); // no verdict-tinted citations
    expect(html).not.toContain('id="verification"');
    expect(html).not.toContain('id="subquestions"');
    rmSync(dir, { recursive: true, force: true });
  });
});
