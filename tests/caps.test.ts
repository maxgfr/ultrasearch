import { describe, expect, it } from "vitest";
import { resolveVariants } from "../src/gather.js";
import { planVariants } from "../src/util.js";
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
    expect(DEEP_CAPS.perSubQuestionSources).toBe(DEPTH_CAPS.deep.maxSources);
  });
});
