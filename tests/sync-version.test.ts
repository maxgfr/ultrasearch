import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/sync-version.mjs runs once per release, from semantic-release, with
// nobody watching its output. It edits the three files by pattern, relative to
// the working directory — so it is run here against a throwaway copy of them.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "sync-version.mjs");

const FILES = {
  "package.json": '{\n  "name": "x",\n  "version": "1.0.0"\n}\n',
  "src/types.ts": 'export const VERSION = "1.0.0";\n',
  "skills/ultrasearch/SKILL.md": "---\nname: x\nmetadata:\n  version: 1.0.0\n---\n",
};

function run(version: string, files: Record<string, string> = FILES) {
  const dir = mkdtempSync(join(tmpdir(), "us-sync-version-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    const r = spawnSync(process.execPath, [SCRIPT, version], { cwd: dir, encoding: "utf8" });
    const after = Object.fromEntries(Object.keys(files).map((path) => [path, readFileSync(join(dir, path), "utf8")]));
    return { status: r.status, stderr: r.stderr, after };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("sync-version", () => {
  it("sets the version in all three files", () => {
    const r = run("2.3.4");
    expect(r.status).toBe(0);
    expect(r.after["package.json"]).toContain('"version": "2.3.4"');
    expect(r.after["src/types.ts"]).toContain('VERSION = "2.3.4"');
    expect(r.after["skills/ultrasearch/SKILL.md"]).toContain("version: 2.3.4");
  });

  it("succeeds when the version is already the one asked for", () => {
    expect(run("1.0.0").status).toBe(0);
  });

  it("fails, and writes nothing, when one file no longer holds a version where it is looked for", () => {
    const r = run("2.3.4", { ...FILES, "src/types.ts": 'export const RELEASE = "1.0.0";\n' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("src/types.ts");
    // The other two were not bumped past the one that could not be.
    expect(r.after["package.json"]).toContain('"version": "1.0.0"');
    expect(r.after["skills/ultrasearch/SKILL.md"]).toContain("version: 1.0.0");
  });
});
