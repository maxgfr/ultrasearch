import { describe, expect, it } from "vitest";
import { runPlan } from "../src/plan.js";
import { planVariants } from "../src/util.js";
import { DEEP_CAPS } from "../src/types.js";

describe("runPlan", () => {
  it("is deterministic for the same (question, mode)", () => {
    const a = runPlan("how does HTTP rate limiting work", "topic");
    const b = runPlan("how does HTTP rate limiting work", "topic");
    expect(a).toEqual(b);
  });

  it("derives facets from the mode template (mode-aware)", () => {
    const topic = runPlan("rate limiting", "topic").subQuestions.map((s) => s.question);
    const research = runPlan("rate limiting", "research").subQuestions.map((s) => s.question);
    expect(topic).not.toEqual(research);
    // a topic facet reflects a topic-template heading
    expect(topic.some((q) => /how it works|history|controversies|practical/i.test(q))).toBe(true);
    // a research facet reflects a research-template heading
    expect(research.some((q) => /key papers|methods|findings|gaps/i.test(q))).toBe(true);
  });

  it("assigns stable Q# ids and caps at DEEP_CAPS.maxSubQuestions", () => {
    const r = runPlan("a fairly rich question about distributed systems and consensus protocols", "topic");
    expect(r.subQuestions.length).toBeGreaterThan(0);
    expect(r.subQuestions.length).toBeLessThanOrEqual(DEEP_CAPS.maxSubQuestions);
    expect(r.subQuestions.map((s) => s.id)).toEqual(r.subQuestions.map((_, i) => `Q${i + 1}`));
  });

  it("gives each sub-question planVariants(deep) queries", () => {
    const r = runPlan("rate limiting", "topic");
    for (const s of r.subQuestions) {
      expect(s.queries).toEqual(planVariants(s.question, "deep"));
      expect(s.queries.length).toBeGreaterThan(0);
    }
  });

  it("--subquestions override bypasses the generator", () => {
    const r = runPlan("rate limiting", "topic", ["token bucket internals", "leaky bucket vs token bucket"]);
    expect(r.subQuestions.length).toBe(2);
    expect(r.subQuestions.every((s) => s.facet === "agent")).toBe(true);
    expect(r.subQuestions[0]!.question).toBe("token bucket internals");
    expect(r.subQuestions.map((s) => s.id)).toEqual(["Q1", "Q2"]);
  });

  it("adds an identifier facet (kept ahead of the cap) when the question has identifiers", () => {
    const r = runPlan("why am I getting HTTP 429 errors from the rate limiter", "bug");
    const ident = r.subQuestions.find((s) => s.facet === "identifier");
    expect(ident).toBeDefined();
    expect(ident!.rationale).toMatch(/429/);
  });

  it("dedupes case-insensitively and never emits an empty sub-question", () => {
    const r = runPlan("rate limiting", "topic", ["Token Bucket", "token bucket", "  ", "leaky bucket"]);
    expect(r.subQuestions.map((s) => s.question)).toEqual(["Token Bucket", "leaky bucket"]);
  });

  it("leaves out undefined when no --run-root is given", () => {
    const r = runPlan("rate limiting", "topic");
    expect(r.subQuestions.every((s) => s.out === undefined)).toBe(true);
  });

  it("assigns a deterministic <root>/qN out dir per sub-question with --run-root", () => {
    const r = runPlan("rate limiting", "topic", undefined, undefined, "/tmp/deep");
    expect(r.subQuestions.length).toBeGreaterThan(0);
    for (const s of r.subQuestions) {
      expect(s.out).toBe(`/tmp/deep/${s.id.toLowerCase()}`);
    }
    // stable across runs
    const again = runPlan("rate limiting", "topic", undefined, undefined, "/tmp/deep");
    expect(again.subQuestions.map((s) => s.out)).toEqual(r.subQuestions.map((s) => s.out));
  });
});
