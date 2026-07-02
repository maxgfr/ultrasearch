import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGather } from "../src/gather.js";
import { writeHtml } from "../src/render.js";
import { runCheck } from "../src/check.js";
import type { GatherOptions } from "../src/types.js";

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

// The whole contract the SKILL promises, end to end and fully offline (fixture
// backend): gather a dossier → write grounded tiers → render HTML → check passes.
// This is the integration safety net over every retrieval/scoring/extraction
// change in the earlier phases.
describe("e2e: gather → write tiers → render → check (offline, fixture)", () => {
  it("produces a grounded dossier that passes check and renders HTML", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-e2e-"));
    try {
      const r = await runGather(opts({ backends: ["fixture"], out: dir }));
      expect(r.sources.length).toBeGreaterThan(0);
      const ids = r.sources.map((s) => s.id);
      const cite = ids
        .slice(0, 2)
        .map((id) => `[${id}]`)
        .join("");

      writeFileSync(join(dir, "SUMMARY.md"), `# Summary\n\nRate limiting caps the request rate to protect a service [${ids[0]}].\n`);
      writeFileSync(
        join(dir, "REPORT.md"),
        `# Report\n\n## Overview\n\nRate limiting controls the rate of requests sent to a service to prevent overload ${cite}.\n\n## Sources\n`,
      );
      writeFileSync(
        join(dir, "FULL.md"),
        `# Full\n\n## Overview\n\nRate limiting caps how many requests a client may send in a window, protecting the service ${cite}.\n\n## Sources\n`,
      );

      const html = writeHtml(dir);
      expect(existsSync(html)).toBe(true);

      const res = runCheck(dir);
      expect(res.ok).toBe(true);
      expect(res.sourceCitations).toBeGreaterThan(0);
      expect(res.dangling).toEqual([]);
      expect(res.unmarkedUnsourced).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
