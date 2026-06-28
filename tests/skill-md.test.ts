import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { VERSION } from "../src/types.js";
import { COMMANDS } from "../src/cli.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The skill is packaged under skills/ultrasearch/ (not the repo root) so that
// `npx skills add` bundles the engine + references with the SKILL.md — a root
// SKILL.md would be installed alone. See scripts/verify-skill-bundle.mjs.
const SKILL_DIR = join(ROOT, "skills", "ultrasearch");
const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");

function frontmatter(md: string): any {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (!m) throw new Error("no frontmatter");
  return parse(m[1]!);
}

describe("SKILL.md", () => {
  const fm = frontmatter(skill);

  it("has valid frontmatter (name, license, version)", () => {
    expect(fm.name).toBe("ultrasearch");
    expect(fm.license).toBe("MIT");
    expect(fm.metadata?.version).toBeDefined();
  });

  it("keeps metadata.version in lockstep with src/types VERSION", () => {
    expect(String(fm.metadata.version)).toBe(VERSION);
  });

  it("has a trigger-rich description", () => {
    expect(fm.description.length).toBeGreaterThan(200);
    expect(fm.description.toLowerCase()).toContain("check");
  });

  it("only documents commands that actually exist", () => {
    const referenced = new Set([...skill.matchAll(/ultrasearch\.mjs\s+([a-z-]+)/g)].map((m) => m[1]));
    for (const cmd of referenced) {
      expect(COMMANDS.has(cmd!), `SKILL.md references unknown command "${cmd}"`).toBe(true);
    }
    // and the core commands are documented
    for (const core of ["gather", "fetch", "render", "check"]) {
      expect(referenced.has(core), `SKILL.md should document "${core}"`).toBe(true);
    }
  });

  it("references only reference files that exist on disk", () => {
    const refs = [...skill.matchAll(/references\/([a-z-]+\.md)/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of new Set(refs)) {
      expect(existsSync(join(SKILL_DIR, "references", r)), `missing references/${r}`).toBe(true);
    }
  });
});
