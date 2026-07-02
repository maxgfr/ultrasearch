import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGather } from "../src/gather.js";
import type { GatherOptions, Manifest, Source } from "../src/types.js";
import { installFetchMock, routes } from "./fetchmock.js";

afterEach(() => vi.unstubAllGlobals());

function opts(over: Partial<GatherOptions>): GatherOptions {
  return {
    question: "what is rate limiting",
    mode: "topic",
    depth: "standard",
    maxSources: 25,
    perSource: 6,
    lang: "en",
    webEngine: "auto",
    excludeDomains: [],
    json: false,
    ...over,
  };
}

describe("runGather (offline, fixture backend)", () => {
  const dir = join(tmpdir(), "us-gather-fixture");
  it("writes a complete dossier with no network", async () => {
    rmSync(dir, { recursive: true, force: true });
    const r = await runGather(opts({ backends: ["fixture"], out: dir }));
    expect(r.sources.length).toBe(3);
    expect(existsSync(join(dir, "sources.json"))).toBe(true);
    expect(existsSync(join(dir, "DOSSIER.md"))).toBe(true);

    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources[0]!.id).toBe("S1");
    expect(sources.every((s) => existsSync(join(dir, s.extract)))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    expect(manifest.backendsUsed).toContain("fixture");
    expect(manifest.notes.join(" ")).toMatch(/fetch --url/); // the enrich nudge
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runGather (locale + pagination manifest fields)", () => {
  const dir = join(tmpdir(), "us-gather-locale");
  it("records pages (per depth) and region on the manifest", async () => {
    rmSync(dir, { recursive: true, force: true });
    const r = await runGather(opts({ backends: ["fixture"], out: dir, lang: "de", region: "de" }));
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    expect(manifest.pages).toBe(2); // standard depth default
    expect(manifest.region).toBe("de");
    expect(manifest.lang).toBe("de");
    expect(r.manifest.pages).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
  it("omits region when not supplied", async () => {
    rmSync(dir, { recursive: true, force: true });
    await runGather(opts({ backends: ["fixture"], out: dir }));
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    expect(manifest.region).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runGather (thin-dossier recall floor)", () => {
  const dir = join(tmpdir(), "us-gather-thin");
  it("flags a thin dossier on the manifest + DOSSIER.md banner", async () => {
    rmSync(dir, { recursive: true, force: true });
    // fixture yields 3 sources; standard recall floor is 6 → thin.
    const r = await runGather(opts({ backends: ["fixture"], out: dir }));
    expect(r.sources.length).toBeLessThan(6);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    expect(manifest.recallFloor).toBeDefined();
    expect(manifest.recallFloor!.count).toBe(r.sources.length);
    expect(manifest.recallFloor!.floor).toBe(6);
    expect(manifest.notes.join(" ")).toMatch(/thin dossier/i);
    expect(readFileSync(join(dir, "DOSSIER.md"), "utf8")).toMatch(/Thin dossier/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not flag thin when --max-sources is below the floor (no false positive)", async () => {
    rmSync(dir, { recursive: true, force: true });
    // asking for at most 2 sources and getting them is not 'thin'.
    const r = await runGather(opts({ backends: ["fixture"], out: dir, maxSources: 2 }));
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    expect(r.sources.length).toBe(2);
    expect(manifest.recallFloor).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runGather (research mode emits refs.bib)", () => {
  const dir = join(tmpdir(), "us-gather-research");
  it("writes refs.bib for the research mode", async () => {
    rmSync(dir, { recursive: true, force: true });
    // fixture backend keeps it offline; refs.bib is written because research's
    // extras include bibtex (fixture sources carry no metadata → header only).
    await runGather(opts({ mode: "research", backends: ["fixture"], out: dir }));
    expect(existsSync(join(dir, "refs.bib"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runGather (hydrate via generic backend)", () => {
  const dir = join(tmpdir(), "us-gather-generic");
  it("fetches full page text for discovered URLs", async () => {
    rmSync(dir, { recursive: true, force: true });
    installFetchMock(
      routes([
        ["page-a", { body: "<title>A</title><h1>A</h1><p>alpha content about limits</p>" }],
        ["page-b", { body: "<title>B</title><p>beta content</p>" }],
      ]),
    );
    const r = await runGather(
      opts({
        backends: ["generic"],
        urls: ["https://x.test/page-a", "https://x.test/page-b"],
        out: dir,
      }),
    );
    expect(r.sources.length).toBe(2);
    const s1 = readFileSync(join(dir, r.sources[0]!.extract), "utf8");
    expect(s1.toLowerCase()).toMatch(/alpha|beta/);
    // both pages fetched successfully → full text on file, no snippet-only marker
    expect(r.sources.every((s) => s.fullText !== false)).toBe(true);
    expect(readFileSync(join(dir, "DOSSIER.md"), "utf8")).not.toMatch(/snippet only/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runGather (snippet-only from a failed page fetch — A5 end-to-end)", () => {
  const dir = join(tmpdir(), "us-gather-snippetonly");
  it("marks a discovery result whose page fetch fails as fullText:false + DOSSIER 'snippet only'", async () => {
    rmSync(dir, { recursive: true, force: true });
    // searxng is a discovery backend (snippet, no text) → gather hydrates each
    // result page. full.test fetches OK; thin.test 404s → snippet-only fallback.
    installFetchMock((url) => {
      if (url.includes("format=json"))
        return {
          body: JSON.stringify({
            results: [
              { url: "https://full.test/p", title: "Full", content: "a snippet about distributed consensus" },
              { url: "https://thin.test/p", title: "Thin", content: "only the search snippet survives here" },
            ],
          }),
          contentType: "application/json",
        };
      if (url.includes("full.test/p")) return { body: "<title>Full</title><h1>Full</h1><p>the full fetched body text about raft and paxos consensus</p>" };
      return undefined; // thin.test/p → 404 → snippet-only
    });
    const r = await runGather(opts({ backends: ["searxng"], searxng: "http://localhost:8888", out: dir }));
    expect(r.sources.length).toBe(2);
    const thin = r.sources.find((s) => s.url.includes("thin.test"))!;
    const full = r.sources.find((s) => s.url.includes("full.test"))!;
    expect(thin.fullText).toBe(false); // page fetch failed → snippet only
    expect(full.fullText).not.toBe(false); // page fetched → full text
    expect(readFileSync(join(dir, "DOSSIER.md"), "utf8")).toMatch(/snippet only/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runGather (exclude-domains)", () => {
  const dir = join(tmpdir(), "us-gather-exclude");
  it("drops excluded hosts", async () => {
    rmSync(dir, { recursive: true, force: true });
    installFetchMock(routes([["keep.test", { body: "<p>kept content here</p>" }]]));
    const r = await runGather(
      opts({
        backends: ["generic"],
        urls: ["https://keep.test/a", "https://drop.test/b"],
        excludeDomains: ["drop.test"],
        out: dir,
      }),
    );
    expect(r.sources.map((s) => s.domain)).toEqual(["keep.test"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
