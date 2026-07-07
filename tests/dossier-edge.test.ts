import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { readJson, buildSource, readSourceText } from "../src/dossier.js";
import type { RawSource, Source } from "../src/types.js";

// readJson names WHAT + WHERE in both failure modes so main().catch prints a
// clean message instead of a raw stack. Cover both the read error and the
// parse error.
describe("readJson", () => {
  it("throws a named 'could not be read' error for a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-readjson-"));
    expect(() => readJson(join(dir, "nope.json"), "sources.json")).toThrow(/sources\.json could not be read/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws a named 'not valid JSON' error for a corrupt file", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-readjson-"));
    const p = join(dir, "manifest.json");
    writeFileSync(p, "{ this is not json ");
    expect(() => readJson(p, "manifest.json")).toThrow(/manifest\.json is not valid JSON/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a valid file", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-readjson-"));
    const p = join(dir, "ok.json");
    writeFileSync(p, JSON.stringify({ a: 1, b: ["x"] }));
    expect(readJson<{ a: number; b: string[] }>(p, "ok.json")).toEqual({ a: 1, b: ["x"] });
    rmSync(dir, { recursive: true, force: true });
  });
});

// buildSource degrades missing fields: text→snippet, empty title→url.
describe("buildSource — field fallbacks", () => {
  it("uses the snippet as text and the url as title when both are missing", () => {
    const rs = { url: "https://x.test/p", title: "", backend: "duckduckgo", score: 1, snippet: "just a snippet" } as RawSource;
    const s = buildSource(rs, "S1", "2026-06-13T10:00:00.000Z", "q");
    expect(s.title).toBe("https://x.test/p"); // empty title → url
    expect(s.snippet).toBe("just a snippet"); // snippet carried through
  });
});

// readSourceText: a well-formed header with an empty body falls back to the snippet.
describe("readSourceText — empty body", () => {
  it("returns the snippet when the extract has a header but no body", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-rst-empty-"));
    mkdirSync(join(dir, "sources"), { recursive: true });
    writeFileSync(join(dir, "sources/S1.md"), "# S1 — T\n- url: https://x.test/1\n- backend: duckduckgo · fetched · trust · score\n\n   \n");
    const s = {
      id: "S1",
      url: "https://x.test/1",
      canonicalUrl: "https://x.test/1",
      title: "T",
      backend: "duckduckgo",
      fetchedAt: "t",
      domain: "x.test",
      trust: 0.5,
      score: 1,
      extract: "sources/S1.md",
      snippet: "fallback snip",
    } as Source;
    expect(readSourceText(dir, s)).toBe("fallback snip");
    rmSync(dir, { recursive: true, force: true });
  });
});
