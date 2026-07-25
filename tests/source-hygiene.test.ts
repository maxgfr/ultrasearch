import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|md)$/.test(e.name)) out.push(p);
  }
  return out;
}

// A literal NUL byte inside a source file is almost always an accident: editors
// and the terminal render it as a space, so it is invisible in review, while git
// and grep classify the whole file as BINARY — diffs collapse to "Bin x -> y
// bytes" and the file silently disappears from search results.
//
// This bit us for real: two composite-key separators (`${a}\u0000${b}`) had been
// committed as raw NULs, which is why `src/check.ts` was ungreppable. Write the
// ESCAPE (\u0000) instead — the runtime string is identical, the source stays
// text.
describe("source hygiene", () => {
  const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "tests")), ...walk(join(ROOT, "scripts")), ...walk(join(ROOT, "evals"))];

  it("scans a non-trivial number of files (guard against a broken walk)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("contains no literal NUL byte — use the \\u0000 escape instead", () => {
    const offenders = files
      .map((f) => ({ f, at: readFileSync(f).indexOf(0) }))
      .filter((x) => x.at !== -1)
      .map((x) => `${x.f.slice(ROOT.length + 1)} (byte ${x.at})`);
    expect(offenders, `literal NUL byte(s) found — git/grep treat these files as binary:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("is valid UTF-8 throughout", () => {
    const bad = files.filter((f) => {
      const b = readFileSync(f);
      return !Buffer.from(b.toString("utf8"), "utf8").equals(b);
    });
    expect(bad.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });
});
