import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveVariants } from "../src/gather.js";
import { planVariants } from "../src/util.js";
import { runPlan } from "../src/plan.js";
import { runVerify } from "../src/verify.js";
import { DEEP_CAPS, DEPTH_CAPS } from "../src/types.js";
import type { GatherOptions } from "../src/types.js";

function opts(over: Partial<GatherOptions>): GatherOptions {
  return {
    question: "what is rate limiting and how do token buckets work in practice",
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

// P1.11 — the two variant-count caps are intentionally different (agent-supplied
// 2/4/6 vs deterministic planner 1/2/3). Pin BOTH so a change to either is a
// conscious decision, not silent drift.
describe("variant-count caps (agent vs planner)", () => {
  const many = ["q1", "q2", "q3", "q4", "q5", "q6", "q7"];
  it("caps agent --queries at 2/4/6 by depth", () => {
    expect(resolveVariants(opts({ depth: "summary", queries: many })).length).toBe(2);
    expect(resolveVariants(opts({ depth: "standard", queries: many })).length).toBe(4);
    expect(resolveVariants(opts({ depth: "deep", queries: many })).length).toBe(6);
  });

  it("caps the deterministic planner at 1/2/3 by depth", () => {
    const q = "why does nginx return 429 too many requests under a token bucket rate limiter";
    expect(planVariants(q, "summary").length).toBe(1);
    expect(planVariants(q, "standard").length).toBeLessThanOrEqual(2);
    expect(planVariants(q, "deep").length).toBeLessThanOrEqual(3);
    // deep must offer at least as many as standard (monotone in depth)
    expect(planVariants(q, "deep").length).toBeGreaterThanOrEqual(planVariants(q, "standard").length);
  });
});

describe("DEEP_CAPS ↔ DEPTH_CAPS coherence", () => {
  it("perSubQuestionSources tracks the deep maxSources the fan-out actually uses", () => {
    // The deep playbook fans out `gather --depth deep` per sub-question and relies
    // on this equality instead of passing --max-sources explicitly. If either
    // number moves, update both (or start passing --max-sources).
    // This equality is ALSO why perSubQuestionSources is advisory rather than
    // enforced: passing it as --max-sources would be a literal no-op.
    expect(DEEP_CAPS.perSubQuestionSources).toBe(DEPTH_CAPS.deep.maxSources);
  });
});

// The docs used to claim all four DEEP_CAPS "bound the loop so it can't run
// away". Only two are enforced by the engine; the other two are budget guidance
// for the agent. Pin the distinction so neither the comments nor the docs rot.
describe("DEEP_CAPS: which caps the ENGINE actually enforces", () => {
  it("enforces maxSubQuestions in plan", () => {
    const p = runPlan("how do distributed rate limiters stay consistent across regions", "topic");
    expect(p.subQuestions.length).toBeLessThanOrEqual(DEEP_CAPS.maxSubQuestions);
  });

  it("enforces maxVerify in the verify worklist", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-caps-"));
    try {
      const sources = Array.from({ length: 3 }, (_, i) => ({
        id: `S${i + 1}`,
        url: `https://ex${i}.test`,
        title: `t${i}`,
        backend: "fixture",
        trust: 0.5,
        score: 1,
        snippet: "s",
        extract: `sources/S${i + 1}.md`,
      }));
      mkdirSync(join(dir, "sources"), { recursive: true });
      for (const s of sources) writeFileSync(join(dir, s.extract), "rate limiting caps request rates in a window");
      writeFileSync(join(dir, "sources.json"), JSON.stringify(sources));
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ question: "q", mode: "topic", depth: "deep" }));
      // More claim↔source pairs than the cap allows.
      const claims = Array.from({ length: 30 }, (_, i) => `## C${i}\nClaim number ${i} about rate limiting windows [S1][S2][S3].`).join("\n\n");
      writeFileSync(join(dir, "REPORT.md"), `# R\n${claims}\n`);

      expect(runVerify(dir, {}).pairs.length).toBeLessThanOrEqual(DEEP_CAPS.maxVerify);
      expect(runVerify(dir, { maxVerify: 5 }).pairs.length).toBeLessThanOrEqual(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT enforce the advisory pair — no engine symbol reads them", () => {
    // maxRounds is agent-driven (nothing counts rounds) and perSubQuestionSources
    // is redundant with DEPTH_CAPS.deep.maxSources. Both are numbers the
    // orchestrator honours, not gates the engine applies.
    expect(DEEP_CAPS.maxRounds).toBeGreaterThan(0);
    expect(DEEP_CAPS.perSubQuestionSources).toBeGreaterThan(0);
  });
});
