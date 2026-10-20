import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Check the shipped configuration, not a fixture or the user's installed copy.
const skillDir = new URL("../skills/ultrasearch/", import.meta.url);
const skill = readFileSync(new URL("SKILL.md", skillDir), "utf8");
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill)?.[1] ?? "";

describe("model-invocable skill, on request", () => {
  it("lets the agent load the skill when the user asks for it", () => {
    expect(frontmatter).not.toMatch(/^disable-model-invocation:\s*true\s*$/m);
    expect(frontmatter).toMatch(/^description:\s*\S/m);
  });

  it("restricts the description to explicit requests", () => {
    const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1] ?? "";
    expect(description).toContain("Use only when the user explicitly asks for ultrasearch or web research.");
  });

  it("keeps the named skill available to users", () => {
    expect(frontmatter).toMatch(/^name:\s*ultrasearch\s*$/m);
    expect(frontmatter).not.toMatch(/^user-invocable:\s*(?:false|no|off|0)\s*$/im);
  });
});
