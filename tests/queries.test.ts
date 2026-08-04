import { describe, expect, it } from "vitest";
import { planQueries, formatQueryPlan } from "../src/queries.js";
import { listModes } from "../src/modes/registry.js";
import { ALL_DEPTHS, ALL_MODES } from "../src/types.js";

describe("planQueries — the WebSearch worklist", () => {
  it("widens the sweep with depth: one query is not a sweep", () => {
    const targets = ALL_DEPTHS.map((depth) => planQueries({ question: "q", mode: "topic", depth }).target);
    expect(targets).toEqual([2, 4, 8]);
    // Deliberately wider than the engine's own planner (1/2/3): those variants
    // feed scrapers that rate-limit, these feed the harness's search tool.
    for (const depth of ALL_DEPTHS) {
      const p = planQueries({ question: "what is rate limiting", mode: "topic", depth });
      expect(p.target, depth).toBeGreaterThanOrEqual(p.planned.length);
    }
  });

  it("hands over the MODE's angles, not a generic list", () => {
    const bug = planQueries({ question: "TypeError: x is undefined", mode: "bug", depth: "standard" });
    expect(bug.angles.join(" ")).toMatch(/verbatim/i);
    const startup = planQueries({ question: "note-taking apps", mode: "startup", depth: "standard" });
    expect(startup.angles.join(" ")).toMatch(/competitor|alternatives|pricing/i);
    expect(bug.angles).not.toEqual(startup.angles);
  });

  it("never promises more angles than the mode actually defines", () => {
    for (const mode of ALL_MODES) {
      const p = planQueries({ question: "q", mode, depth: "deep" });
      expect(p.angles.length, mode).toBeGreaterThan(0);
      expect(p.angles.length, mode).toBeLessThanOrEqual(p.target);
    }
  });

  it("every mode defines enough angles to fill the DEEPEST sweep", () => {
    // A mode with fewer angles than the deep target makes `queries` announce a
    // budget it cannot cover — it printed "Run 8" over a list of 6 before this
    // was asserted. The command exists to widen the sweep; under-filling it is
    // the exact failure it is supposed to prevent.
    const deepTarget = planQueries({ question: "q", mode: "topic", depth: "deep" }).target;
    for (const m of listModes()) expect(m.searchAngles.length, m.name).toBeGreaterThanOrEqual(deepTarget);
  });

  it("never announces a budget it does not list angles for", () => {
    for (const mode of ALL_MODES) {
      for (const depth of ALL_DEPTHS) {
        const p = planQueries({ question: "q", mode, depth });
        const text = formatQueryPlan(p);
        const listed = text.split("\n").filter((l) => /^ {2}\d+\. /.test(l)).length;
        expect(listed, `${mode}/${depth}`).toBe(p.angles.length);
        // Either the angles fill the budget, or the text says how many are yours.
        if (p.angles.length < p.target) expect(text).toMatch(new RegExp(`${p.target - p.angles.length} of your own`));
        else expect(text).toMatch(new RegExp(`Run ${p.target} DISTINCT`));
      }
    }
  });

  it("carries the search language through, and names the follow-up command", () => {
    const p = planQueries({ question: "limitation de débit", mode: "topic", depth: "summary", lang: "fr" });
    expect(p.lang).toBe("fr");
    expect(p.next).toMatch(/--web-results/);
    const text = formatQueryPlan(p);
    expect(text).toMatch(/phrased in fr/);
    expect(text).toMatch(/gather --q "limitation de débit"/);
  });
});
