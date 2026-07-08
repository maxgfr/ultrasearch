import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPlan, subjectOf, facetQuestion } from "../src/plan.js";
import { DEEP_CAPS } from "../src/types.js";

describe("runPlan", () => {
  it("is deterministic for the same (question, mode)", () => {
    const a = runPlan("how does HTTP rate limiting work", "topic");
    const b = runPlan("how does HTTP rate limiting work", "topic");
    expect(a).toEqual(b);
  });

  it("derives interrogative facets from the mode template (mode-aware)", () => {
    const topic = runPlan("rate limiting", "topic").subQuestions;
    const research = runPlan("rate limiting", "research").subQuestions;
    const tq = topic.map((s) => s.question);
    expect(tq).not.toEqual(research.map((s) => s.question));
    // template facets are real interrogatives about the subject, not "<q> — heading"
    const templateFacets = topic.filter((s) => s.facet === "template");
    expect(templateFacets.length).toBeGreaterThan(0);
    for (const s of templateFacets) {
      expect(s.question).not.toContain(" — "); // no more label concat
      expect(s.question).toMatch(/\?$/); // a genuine question
      expect(s.question.toLowerCase()).toContain("rate limiting"); // about the subject
    }
    expect(tq.some((q) => /how does .* work under the hood/i.test(q))).toBe(true);
    expect(research.some((s) => /key papers|findings|history and motivation/i.test(s.question))).toBe(true);
  });

  it("makes template facets distinct from each other", () => {
    const facets = runPlan("rate limiting", "topic").subQuestions.filter((s) => s.facet === "template");
    const qs = facets.map((s) => s.question);
    expect(new Set(qs).size).toBe(qs.length);
  });

  it("produces interrogative, subject-bearing facets for every mode", () => {
    for (const mode of ["topic", "bug", "research", "learn", "startup"] as const) {
      const facets = runPlan("api rate limiting", mode).subQuestions.filter((s) => s.facet === "template");
      expect(facets.length).toBeGreaterThan(0);
      for (const s of facets) {
        expect(s.question).toMatch(/\?$/);
        expect(s.question).not.toContain(" — ");
      }
    }
  });

  it("assigns stable Q# ids and caps at DEEP_CAPS.maxSubQuestions", () => {
    const r = runPlan("a fairly rich question about distributed systems and consensus protocols", "topic");
    expect(r.subQuestions.length).toBeGreaterThan(0);
    expect(r.subQuestions.length).toBeLessThanOrEqual(DEEP_CAPS.maxSubQuestions);
    expect(r.subQuestions.map((s) => s.id)).toEqual(r.subQuestions.map((_, i) => `Q${i + 1}`));
  });

  it("gives each sub-question at least one query", () => {
    const r = runPlan("rate limiting", "topic");
    for (const s of r.subQuestions) {
      expect(s.queries.length).toBeGreaterThan(0);
      expect(s.queries.every((q) => q.trim().length > 0)).toBe(true);
    }
  });

  it("dedupes queries across facets so no two sub-questions issue the same search", () => {
    const r = runPlan("rate limiting", "topic");
    const all = r.subQuestions.flatMap((s) => s.queries.map((q) => q.toLowerCase()));
    expect(new Set(all).size).toBe(all.length);
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
    const root = mkdtempSync(join(tmpdir(), "us-plan-"));
    const r = runPlan("rate limiting", "topic", undefined, undefined, root);
    expect(r.subQuestions.length).toBeGreaterThan(0);
    for (const s of r.subQuestions) {
      expect(s.out).toBe(join(root, s.id.toLowerCase()));
    }
    // stable across runs
    const again = runPlan("rate limiting", "topic", undefined, undefined, root);
    expect(again.subQuestions.map((s) => s.out)).toEqual(r.subQuestions.map((s) => s.out));
    rmSync(root, { recursive: true, force: true });
  });

  it("writes PLAN.json under --run-root", () => {
    const root = mkdtempSync(join(tmpdir(), "us-plan-"));
    const r = runPlan("rate limiting", "topic", undefined, undefined, root);
    const p = join(root, "PLAN.json");
    expect(existsSync(p)).toBe(true);
    const onDisk = JSON.parse(readFileSync(p, "utf8"));
    expect(onDisk).toEqual(r);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("subjectOf", () => {
  it("strips research scaffolding down to the subject", () => {
    expect(subjectOf("deep research on HTTP 429 rate limiting")).toBe("HTTP 429 rate limiting");
    expect(subjectOf("what is a token bucket?")).toBe("token bucket");
    expect(subjectOf("teach me about leaky buckets")).toBe("leaky buckets");
  });
  it("falls back to the whole question when the residue is too thin", () => {
    expect(subjectOf("what is it")).toBe("what is it");
  });
});

describe("facetQuestion", () => {
  it("maps a heading to an interrogative about the subject with facet terms", () => {
    const fq = facetQuestion("rate limiting", "How it works / key concepts");
    expect(fq.question).toBe("How does rate limiting work under the hood?");
    expect(fq.terms.length).toBeGreaterThan(0);
  });
  it("uses a generic question (never the raw concat) for an unmatched heading", () => {
    const fq = facetQuestion("rate limiting", "Wild Uncharted Territory");
    expect(fq.question).toContain("rate limiting");
    expect(fq.question).not.toContain(" — ");
    expect(fq.question).toMatch(/\?$/);
  });
});
