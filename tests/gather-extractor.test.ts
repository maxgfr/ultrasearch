import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGather } from "../src/gather.js";
import { makeCtx } from "./ctx.js";

const { fetchPage } = vi.hoisted(() => ({ fetchPage: vi.fn() }));
vi.mock("../src/cache.js", async (original) => ({
  ...(await original<typeof import("../src/cache.js")>()),
  cachedFetchAndExtract: fetchPage,
}));

it.each(["firecrawl", undefined])("reports the actual %s extractor used by generic URLs", async (extractor) => {
  const dir = mkdtempSync(join(tmpdir(), "us-extractor-"));
  try {
    fetchPage.mockResolvedValue({
      title: "Rate limiting",
      text: "Rate limiting controls request throughput using token buckets and request counters.",
      status: 200,
      extractor,
    });
    const result = await runGather(
      makeCtx("rate limiting", {
        backends: ["generic"],
        urls: ["https://docs.test/rate", "https://docs.test/rate"],
        out: dir,
      }).options,
    );
    expect(result.sources).toHaveLength(1);
    expect(result.manifest.services?.firecrawl.pages).toBe(extractor === "firecrawl" ? 1 : 0);
    if (extractor) {
      expect(result.sources[0]?.meta?.extractor).toBe(extractor);
      expect(result.manifest.notes.join(" ")).not.toContain("firecrawl ✗ not used");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
