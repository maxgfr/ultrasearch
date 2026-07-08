import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runBrainstorm } from "../src/brainstorm.js";
import type { GatherOptions } from "../src/types.js";
import { installFetchMock } from "./fetchmock.js";

afterEach(() => vi.unstubAllGlobals());

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-brainstorm-"));
}
function opts(question: string, over: Partial<GatherOptions> = {}): GatherOptions {
  return {
    question,
    mode: "topic",
    depth: "standard",
    maxSources: 25,
    perSource: 6,
    lang: "en",
    webEngine: "auto",
    excludeDomains: [],
    json: false,
    backends: ["fixture"],
    ...over,
  };
}

describe("runBrainstorm", () => {
  it("flags a one-word question as under-specified (offline fixture)", async () => {
    const dir = scratch();
    const r = await runBrainstorm(opts("rust", { out: dir }));
    expect(r.signals.ambiguous).toBe(true);
    expect(r.signals.words).toBe(1);
    expect(r.signals.reasons.join(" ")).toMatch(/content word/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("treats a specific interrogative question as researchable", async () => {
    const dir = scratch();
    const r = await runBrainstorm(opts("how does HTTP 429 rate limiting work in practice?", { out: dir }));
    expect(r.signals.interrogative).toBe(true);
    expect(r.signals.ambiguous).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes BRAINSTORM.json and BRAINSTORM.md", async () => {
    const dir = scratch();
    const r = await runBrainstorm(opts("rate limiting", { out: dir }));
    expect(existsSync(join(dir, "BRAINSTORM.json"))).toBe(true);
    expect(existsSync(join(dir, "BRAINSTORM.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "BRAINSTORM.json"), "utf8"))).toEqual(r);
    expect(readFileSync(join(dir, "BRAINSTORM.md"), "utf8")).toContain("Questions to ask the user");
    rmSync(dir, { recursive: true, force: true });
  });

  it("always proposes 2-4 clarifying user questions", async () => {
    const dir = scratch();
    const r = await runBrainstorm(opts("mercury", { out: dir }));
    expect(r.userQuestions.length).toBeGreaterThanOrEqual(2);
    expect(r.userQuestions.length).toBeLessThanOrEqual(4);
    rmSync(dir, { recursive: true, force: true });
  });

  it("proposes candidate refined questions as interrogatives about the subject", async () => {
    const dir = scratch();
    const r = await runBrainstorm(opts("rate limiting", { out: dir }));
    expect(r.candidateQuestions.length).toBeGreaterThan(0);
    for (const c of r.candidateQuestions) {
      expect(c.question).toMatch(/\?$/);
      expect(c.question).not.toContain(" — ");
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("clusters a homonym probe into multiple disjoint angles → ambiguous", async () => {
    // A web probe whose titles span three unrelated domains for "mercury".
    const DDG = `
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2Fplanet">Mercury planet orbit sun solar</a><a class="result__snippet">the planet Mercury</a>
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.test%2Fmetal">Mercury metal element toxic liquid</a><a class="result__snippet">the metal mercury</a>
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fc.test%2Fband">Mercury Freddie band queen music</a><a class="result__snippet">Freddie Mercury</a>`;
    installFetchMock((url) => {
      if (url.includes("html.duckduckgo.com")) return { body: DDG };
      if (url.includes("/search/page")) return { body: JSON.stringify({ pages: [] }), contentType: "application/json" };
      return undefined;
    });
    const dir = scratch();
    const r = await runBrainstorm(opts("mercury", { backends: ["duckduckgo"], out: dir }));
    expect(r.angles.length).toBeGreaterThanOrEqual(3);
    expect(r.signals.reasons.join(" ")).toMatch(/ambiguous|cluster/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not crash on an empty probe (backend returns nothing)", async () => {
    installFetchMock(() => ({ status: 500, body: "" }));
    const dir = scratch();
    const r = await runBrainstorm(opts("some very specific niche question about widgets", { backends: ["duckduckgo"], out: dir }));
    expect(r.angles).toEqual([]);
    expect(r.userQuestions.length).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(dir, "BRAINSTORM.md"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults the output dir when --out is omitted", async () => {
    const r = await runBrainstorm(opts("rate limiting"));
    expect(r.dir).toMatch(/brainstorm/);
    expect(existsSync(join(r.dir, "BRAINSTORM.json"))).toBe(true);
    rmSync(r.dir, { recursive: true, force: true });
  });
});
