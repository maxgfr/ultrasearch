import { describe, expect, it } from "vitest";
import { MODES, getMode, listModes } from "../src/modes/registry.js";
import { ALL_MODES } from "../src/types.js";
import { resolveBackends } from "../src/gather.js";
import { makeCtx } from "./ctx.js";

describe("modes registry", () => {
  it("has a profile for every mode name", () => {
    for (const name of ALL_MODES) {
      const m = getMode(name);
      expect(m.name).toBe(name);
      expect(m.backends.length).toBeGreaterThan(0);
      expect(m.template).toContain("## Sources");
    }
  });

  it("lists all five modes", () => {
    expect(listModes()).toHaveLength(5);
    expect(Object.keys(MODES).sort()).toEqual([...ALL_MODES].sort());
  });

  it("research mode emits bibtex; learn mode emits glossary + exercises", () => {
    expect(getMode("research").extras).toContain("bibtex");
    expect(getMode("learn").extras).toEqual(expect.arrayContaining(["glossary", "exercises"]));
  });
});

describe("resolveBackends", () => {
  it("uses the mode profile by default", () => {
    const opts = makeCtx("x", { mode: "topic" }).options;
    expect(resolveBackends(opts, getMode("topic"))).toEqual(getMode("topic").backends);
  });
  it("adds deep-only backends at --depth deep", () => {
    const opts = makeCtx("x", { mode: "research", depth: "deep" }).options;
    const r = resolveBackends(opts, getMode("research"));
    expect(r).toEqual(expect.arrayContaining(getMode("research").deepOnly));
  });
  it("honors an explicit --backends override", () => {
    const opts = makeCtx("x", { backends: ["fixture"] }).options;
    expect(resolveBackends(opts, getMode("topic"))).toEqual(["fixture"]);
  });
});
