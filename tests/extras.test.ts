import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EXTRAS, annotateExtras, extraFiles, writeExtras } from "../src/extras.js";
import { listModes } from "../src/modes/registry.js";
import { addSource } from "../src/enrich.js";
import { renderDossierMarkdown, writeDossier } from "../src/dossier.js";
import type { CodesFile } from "../src/codes.js";
import { writeFixtureDossier } from "./dossierfix.js";
import { installFetchMock, routes } from "./fetchmock.js";
import type { GatherOptions, Manifest, RawSource, Source } from "../src/types.js";
import { runGather } from "../src/gather.js";
import { runMerge } from "../src/merge.js";

const DEALS_MANIFEST: Partial<Manifest> = {
  question: "code promo decathlon.fr",
  mode: "deals",
  lang: "fr",
  region: "fr",
  builtAt: "2026-10-01T12:00:00.000Z",
  extras: ["codes"],
};

const readCodes = (dir: string) => JSON.parse(readFileSync(join(dir, "codes.json"), "utf8")) as CodesFile;

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

  it("writeDossier annotates from the FULL text and writes codes.json + the UNVERIFIED block", () => {
    const dir = scratch();
    try {
      const manifest: Manifest = { ...baseManifest(), ...DEALS_MANIFEST };
      // The code sits past what the depth-capped extract keeps — annotation must read rs.text, not the extract.
      const filler = "Lorem ipsum dolor sit amet. ".repeat(400);
      const raws: RawSource[] = [
        { url: "https://a.test/1", title: "A", backend: "duckduckgo", score: 2, snippet: "", text: `${filler}\nAvec le code promo RENTREE10, 10% de remise.` },
        { url: "https://b.test/1", title: "B", backend: "duckduckgo", score: 1, snippet: "", text: "Code promo RENTREE10 : -10% sur tout le site." },
      ];
      const { sources } = writeDossier(dir, raws, manifest, "## T\n## Sources");
      expect(sources[0]!.meta?.codes?.[0]?.code).toBe("RENTREE10");
      const codes = readCodes(dir);
      expect(codes.merchant).toBe("decathlon");
      expect(codes.candidates[0]).toMatchObject({ code: "RENTREE10", sources: ["S1", "S2"], domains: 2 });
      expect(readFileSync(join(dir, "DOSSIER.md"), "utf8")).toContain("Candidate codes (extracted — UNVERIFIED)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ingest folds a new page's codes into codes.json", async () => {
    const dir = scratch();
    try {
      writeFixtureDossier(dir, 1, DEALS_MANIFEST);
      installFetchMock(routes([["deals.test", { body: "<title>Deals</title><p>Utilisez le code promo AUTOMNE15 pour 15% de remise.</p>" }]]));
      const r = await addSource(dir, "https://deals.test/decathlon", {});
      expect(r.added).toBe(true);
      const codes = readCodes(dir);
      expect(codes.candidates.map((c) => c.code)).toEqual(["AUTOMNE15"]);
      expect(codes.candidates[0]!.sources).toEqual([r.id]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a deals gather writes codes.json even when no source carries a code", async () => {
    const dir = scratch();
    try {
      await runGather({ ...GATHER, question: "code promo decathlon.fr", mode: "deals", backends: ["fixture"], out: dir });
      expect(readCodes(dir)).toMatchObject({ merchant: "decathlon", candidates: [], expired: [] });
      expect(readFileSync(join(dir, "DOSSIER.md"), "utf8")).toContain("_No candidate code was extracted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merge keeps each source's codes and re-ranks them across the sub-dossiers", () => {
    const root = scratch();
    try {
      const manifest: Manifest = { ...baseManifest(), ...DEALS_MANIFEST, question: "code promo decathlon.fr" };
      const structured = { codes: [{ code: "APP5", via: "structured" as const, strength: "strong" as const, discount: "5 €" }] };
      writeDossier(
        join(root, "q1"),
        [{ url: "https://www.dealabs.com/t-1", title: "T", backend: "pepper", score: 1, snippet: "", text: "Bon plan.", meta: structured }],
        manifest,
        "## T",
      );
      writeDossier(
        join(root, "q2"),
        [{ url: "https://forum.test/p", title: "F", backend: "reddit", score: 1, snippet: "", text: "Le code promo APP5 marche." }],
        manifest,
        "## T",
      );
      const m = runMerge({ runs: [join(root, "q1"), join(root, "q2")], master: join(root, "m"), mode: "deals" });
      expect(m.sources.find((s) => s.domain === "dealabs.com")?.meta?.codes?.[0]).toMatchObject({ code: "APP5", via: "structured" });
      expect(readCodes(join(root, "m")).candidates[0]).toMatchObject({ code: "APP5", structured: true, domains: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const GATHER: GatherOptions = {
  question: "",
  mode: "topic",
  depth: "standard",
  perSource: 6,
  lang: "fr",
  region: "fr",
  webEngine: "auto",
  excludeDomains: [],
  json: false,
};

function baseManifest(): Manifest {
  return {
    version: "0",
    question: "q",
    mode: "topic",
    depth: "standard",
    lang: "en",
    backends: [],
    backendsUsed: [],
    sourceCount: 0,
    builtAt: "2026-01-01T00:00:00.000Z",
    slug: "x",
    tiers: ["SUMMARY.md", "REPORT.md"],
    extras: [],
    notes: [],
    timings: {},
  };
}

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
