import { describe, expect, it } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderHtml, mdToHtml } from "../src/render.js";
import { writeFixtureDossier } from "./dossierfix.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-render-"));
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
