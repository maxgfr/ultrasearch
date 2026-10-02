import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { browserHome, closeBrowserReads, fetchAndExtract } from "../src/engine.js";

// The browser rung against the real web, with a real browser. OFF unless
// ULTRASEARCH_E2E_BROWSER=1 (`pnpm run e2e:browser`), and never in CI: it needs
// a Chrome/Brave/Chromium/Edge, a display, and the network, and it opens a
// window. Every other test of the rung stubs the engine.
//
// What it proves: a JS shell the built-in reader reads as almost nothing comes
// back as its rendered text through `fallback`, and closeBrowserReads leaves no
// browser process of ours behind.

/** Pids of browsers running on the rung's dedicated profile. */
function ourBrowsers(): Set<string> {
  try {
    return new Set(
      execFileSync("pgrep", ["-f", `user-data-dir=${browserHome()}`], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean),
    );
  } catch {
    return new Set(); // pgrep exits 1 when nothing matches
  }
}

describe.skipIf(process.env.ULTRASEARCH_E2E_BROWSER !== "1")("browser rung — live", () => {
  it("renders a JS shell in a real browser and leaves no process behind", async () => {
    const before = ourBrowsers();
    // Explicit, so the test setup's ULTRASEARCH_BROWSER_FETCH=off does not apply.
    const res = await fetchAndExtract("https://quotes.toscrape.com/js/", { browser: "fallback" });
    try {
      expect(res.extractor).toBe("browser");
      expect(res.text).toContain("Einstein");
    } finally {
      await closeBrowserReads();
    }
    await new Promise((r) => setTimeout(r, 1500));
    const left = [...ourBrowsers()].filter((pid) => !before.has(pid));
    expect(left).toEqual([]);
  }, 120_000);
});
