import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EXTRAS, annotateExtras, extraFiles, writeExtras } from "../src/extras.js";
import { listModes } from "../src/modes/registry.js";
import { addSource } from "../src/enrich.js";
import { renderDossierMarkdown } from "../src/dossier.js";
import { writeFixtureDossier } from "./dossierfix.js";
import { installFetchMock, routes } from "./fetchmock.js";
import type { Manifest, Source } from "../src/types.js";

afterEach(() => vi.unstubAllGlobals());

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-extras-"));
}

describe("extras registry", () => {
  it("has an entry for every extra any mode declares", () => {
    for (const mode of listModes()) {
      for (const extra of mode.extras) expect(EXTRAS[extra], `${mode.name}: ${extra}`).toBeDefined();
    }
  });

  it("lists every artifact an extra can write, once, for --stdout", () => {
    const files = extraFiles();
    expect(files).toContain("refs.bib");
    expect(new Set(files).size).toBe(files.length);
  });

  it("is inert for a manifest with no extras — and tolerates one this version does not know", () => {
    const dir = scratch();
    try {
      const sources = writeFixtureDossier(dir, 1);
      const manifest = { extras: ["no-such-extra"] } as unknown as Manifest;
      expect(writeExtras(dir, sources, manifest)).toEqual([]);
      expect(annotateExtras("text", sources[0]!, manifest)).toBe(sources[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extras follow the index on every path that rewrites it", () => {
  it("ingest writes refs.bib for a research dossier that had none", async () => {
    const dir = scratch();
    try {
      writeFixtureDossier(dir, 1, { mode: "research", extras: ["bibtex"] });
      expect(existsSync(join(dir, "refs.bib"))).toBe(false);
      installFetchMock(routes([["paper.test", { body: "<title>A paper</title><p>rate limiting results</p>" }]]));
      const r = await addSource(dir, "https://paper.test/a", { question: "rate limiting" });
      expect(r.added).toBe(true);
      expect(existsSync(join(dir, "refs.bib"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderDossierMarkdown extra blocks", () => {
  it("places each block after the template and before the sources", () => {
    const manifest = {
      question: "q",
      mode: "topic",
      depth: "standard",
      lang: "en",
      backendsUsed: [],
      builtAt: "2026-01-01T00:00:00.000Z",
      extras: [],
      notes: [],
    } as unknown as Manifest;
    const md = renderDossierMarkdown([] as Source[], manifest, "## T", [["## Extra block", "body"]]);
    expect(md.indexOf("## Extra block")).toBeGreaterThan(md.indexOf("## Report template"));
    expect(md.indexOf("## Extra block")).toBeLessThan(md.indexOf("## Sources"));
  });
});
