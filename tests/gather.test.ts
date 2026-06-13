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
    fresh: false,
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
