import { describe, expect, it } from "vitest";
import { parseWebResults, websearchBackend } from "../src/backends/websearch.js";
import { resolveBackends, resolveSearchProfile, ignoredByExplicitBackends, ignoredByMaxProfile, MAX_PROFILE_KNOBS } from "../src/gather.js";
import { getMode } from "../src/modes/registry.js";
import type { GatherOptions } from "../src/types.js";
import { makeCtx } from "./ctx.js";

function opts(over: Partial<GatherOptions> = {}): GatherOptions {
  return {
    question: "q",
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

describe("parseWebResults — the seam between a model's output and the engine", () => {
  it("reads the canonical shape", () => {
    const r = parseWebResults(JSON.stringify([{ url: "https://a.test/x", title: "A", snippet: "s" }]));
    expect(r.hits).toEqual([{ url: "https://a.test/x", title: "A", snippet: "s" }]);
    expect(r.rejected).toBe(0);
  });

  it("reads a bare array of URL strings", () => {
    const r = parseWebResults(JSON.stringify(["https://a.test/x", "https://b.test/y"]));
    expect(r.hits.map((h) => h.url)).toEqual(["https://a.test/x", "https://b.test/y"]);
  });

  it("unwraps the object forms a search payload usually takes", () => {
    for (const key of ["results", "hits", "items", "web_results", "sources"]) {
      const r = parseWebResults(JSON.stringify({ [key]: [{ url: "https://a.test/x" }] }));
      expect(r.hits, key).toHaveLength(1);
    }
  });

  it("accepts the alternate key spellings a harness (or a model) reaches for", () => {
    const r = parseWebResults(JSON.stringify([{ link: "https://a.test/x", name: "A", description: "d" }]));
    expect(r.hits[0]).toEqual({ url: "https://a.test/x", title: "A", snippet: "d" });
  });

  it("falls back to a newline-separated URL list when the payload is not JSON", () => {
    const r = parseWebResults("https://a.test/x\nhttps://b.test/y\n");
    expect(r.hits.map((h) => h.url)).toEqual(["https://a.test/x", "https://b.test/y"]);
    expect(r.notes.join(" ")).toMatch(/not JSON/i);
  });

  it("COUNTS what it refuses rather than swallowing it", () => {
    const r = parseWebResults(JSON.stringify([{ url: "https://a.test/x" }, { url: "mailto:x@y.z" }, { title: "no url" }, "not a url at all"]));
    expect(r.hits).toHaveLength(1);
    expect(r.rejected).toBe(3);
    expect(r.notes.join(" ")).toMatch(/ignored 3 entries/i);
  });

  it("collapses duplicate URLs, keeping the agent's own ranking", () => {
    const r = parseWebResults(
      JSON.stringify([
        { url: "https://a.test/x", title: "first" },
        { url: "https://a.test/x", title: "second" },
      ]),
    );
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.title).toBe("first");
  });

  it("reports an empty or non-array payload instead of pretending it parsed", () => {
    expect(parseWebResults("").notes.join(" ")).toMatch(/empty/i);
    expect(parseWebResults(JSON.stringify({ nope: 1 })).notes.join(" ")).toMatch(/no array of results/i);
    expect(parseWebResults("   ").hits).toEqual([]);
    // A JSON scalar is neither an array nor a wrapper object.
    expect(parseWebResults("42").notes.join(" ")).toMatch(/no array of results/i);
  });

  it("refuses the malformed entries a hand-written payload actually contains", () => {
    const r = parseWebResults(
      JSON.stringify([
        "", // blank string
        "   ", // whitespace only
        "/relative/path", // not absolute
        ["https://a.test/nested"], // a nested array is not a hit
        null,
        42,
        { url: "" }, // present but empty
        { url: "https://ok.test/x" },
      ]),
    );
    expect(r.hits.map((h) => h.url)).toEqual(["https://ok.test/x"]);
    expect(r.rejected).toBe(7);
  });

  it("keeps a hit whose title/snippet keys are absent or unusable", () => {
    const r = parseWebResults(JSON.stringify([{ url: "https://a.test/x", title: "   ", snippet: 12 }]));
    expect(r.hits[0]).toEqual({ url: "https://a.test/x", title: undefined, snippet: undefined });
  });
});

describe("the websearch backend carries NO privilege", () => {
  it("emits the hits in the agent's order, with no pre-loaded text", async () => {
    const hits = [{ url: "https://a.test/1" }, { url: "https://b.test/2", title: "B" }];
    const res = await websearchBackend(makeCtx("q", { webResults: hits }));
    expect(res.backend).toBe("claude");
    expect(res.items.map((i) => i.url)).toEqual(["https://a.test/1", "https://b.test/2"]);
    expect(res.items[0]!.score).toBeGreaterThan(res.items[1]!.score);
    // No `text` ⇒ the gatherer hydrates the page through the same rescue ladder
    // as every other candidate. A WebSearch hit is not exempt from being read.
    expect(res.items.every((i) => i.text === undefined)).toBe(true);
    expect(res.items[0]!.title).toBe("https://a.test/1"); // falls back to the url
  });

  it("says so when no payload was supplied", async () => {
    const res = await websearchBackend(makeCtx("q"));
    expect(res.items).toHaveLength(0);
    expect(res.notes.join(" ")).toMatch(/no hits supplied/i);
  });
});

describe("--search presets resolve over the existing primitives", () => {
  const hits = [{ url: "https://a.test/1" }];

  it("auto → light once there is a lane, full when there is not", () => {
    expect(resolveSearchProfile(opts({ webResults: hits }))).toBe("light");
    expect(resolveSearchProfile(opts())).toBe("full");
  });

  it("auto keeps a PINNED --web-engine: a pin is a deliberate request, not noise", () => {
    expect(resolveSearchProfile(opts({ webResults: hits, webEngine: "mojeek" }))).toBe("full");
  });

  it("an explicit --search always wins over the auto inference", () => {
    expect(resolveSearchProfile(opts({ search: "full", webResults: hits }))).toBe("full");
    expect(resolveSearchProfile(opts({ search: "light" }))).toBe("light");
  });
});

describe("--search max — the ceiling", () => {
  const topic = getMode("topic");
  const hits = [{ url: "https://a.test/1" }];

  it("adds Firecrawl to DISCOVERY, which no other profile does", () => {
    const b = resolveBackends(opts({ webResults: hits, search: "max" }), topic);
    for (const k of ["claude", "firecrawl", "searxng", "duckduckgo", "ddglite", "mojeek", "marginalia", "wikipedia"]) {
      expect(b, k).toContain(k);
    }
    expect(resolveBackends(opts({ webResults: hits, search: "full" }), topic)).not.toContain("firecrawl");
  });

  it("supersedes a pinned --web-engine, and says so", () => {
    const o = opts({ webResults: hits, search: "max", webEngine: "mojeek" });
    // "max" means every engine; a pin would narrow it back to one.
    expect(resolveBackends(o, topic)).toContain("duckduckgo");
    expect(ignoredByMaxProfile(o)).toEqual(["--web-engine"]);
  });

  it("stays quiet when there was no pin to supersede, and off outside max", () => {
    expect(ignoredByMaxProfile(opts({ webResults: hits, search: "max" }))).toEqual([]);
    expect(ignoredByMaxProfile(opts({ webResults: hits, search: "full", webEngine: "mojeek" }))).toEqual([]);
  });

  it("`auto` NEVER resolves to max — 3 GB of containers is always a decision", () => {
    for (const o of [opts(), opts({ webResults: hits }), opts({ webResults: hits, webEngine: "mojeek" })]) {
      expect(resolveSearchProfile(o)).not.toBe("max");
    }
  });

  it("declares the knob ceiling the docs promise", () => {
    expect(MAX_PROFILE_KNOBS).toEqual({ pages: 5, webBreadth: 5, rounds: 2, perSource: 50 });
  });
});

describe("resolveBackends wires the lane and the profile together", () => {
  const topic = getMode("topic");
  const hits = [{ url: "https://a.test/1" }];

  it("light drops the scraped cascade and SearXNG, keeps the API backends", () => {
    const b = resolveBackends(opts({ webResults: hits }), topic);
    expect(b).toContain("claude");
    expect(b).toContain("wikipedia"); // an API backend: reliable, keyless, kept
    expect(b).not.toContain("duckduckgo");
    expect(b).not.toContain("searxng");
  });

  it("full fuses the lane WITH the keyless cascade", () => {
    const b = resolveBackends(opts({ webResults: hits, search: "full" }), topic);
    expect(b).toContain("claude");
    expect(b).toContain("duckduckgo");
    expect(b).toContain("searxng");
  });

  it("no lane ⇒ the pre-existing behaviour, unchanged", () => {
    const b = resolveBackends(opts(), topic);
    expect(b).not.toContain("claude");
    expect(b).toContain("duckduckgo");
    expect(b).toContain("searxng");
  });

  it("the lane runs even when the mode profile never listed it", () => {
    // research's profile is scholarly APIs only — the agent still searched, so
    // its hits are never thrown away.
    const b = resolveBackends(opts({ webResults: hits }), getMode("research"));
    expect(b).toContain("claude");
    expect(b).toContain("arxiv");
  });
});

describe("--backends names what it voids, including the lane", () => {
  it("reports --web-results and --search when the pin discards them", () => {
    const ignored = ignoredByExplicitBackends(opts({ backends: ["fixture"], webResults: [{ url: "https://a.test/1" }], search: "light" }));
    expect(ignored).toContain("--web-results");
    expect(ignored).toContain("--search");
  });

  it("stays quiet about the lane when the pin deliberately KEEPS it", () => {
    const ignored = ignoredByExplicitBackends(opts({ backends: ["claude"], webResults: [{ url: "https://a.test/1" }] }));
    expect(ignored).not.toContain("--web-results");
  });

  it("says nothing at all without --backends", () => {
    expect(ignoredByExplicitBackends(opts({ webResults: [{ url: "https://a.test/1" }] }))).toEqual([]);
  });
});
