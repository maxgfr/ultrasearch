import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canShowWindow, describeBrowserRung, resolveBrowserRung } from "../src/browser.js";
import { describeServices, probeServices } from "../src/services.js";
import { buildGatherOptions, parseCli, HELP } from "../src/cli.js";
import { emitOrchestration } from "../src/orchestrate.js";
import { TOOLS } from "../src/mcp/tools.js";

// The browser rung: a real, separate Chrome/Brave the engine renders a page in
// when the built-in reader is refused, walled or handed a JS shell. These tests
// pin how ultrasearch DECIDES whether that rung is on — never a real browser:
// detection is injected, and the test setup forces ULTRASEARCH_BROWSER_FETCH=off.

const brave = () => ({ kind: "brave" as const, path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" });
const none = () => null;

afterEach(() => vi.unstubAllEnvs());

describe("resolveBrowserRung — the default", () => {
  it("is fallback when a browser is installed and a window can be shown", () => {
    const r = resolveBrowserRung({ env: {}, platform: "darwin", detect: brave });
    expect(r).toMatchObject({ mode: "fallback", source: "default", binary: brave() });
    expect(r.reason).toBeUndefined();
  });

  it("is off when no Chrome, Brave, Chromium or Edge is installed, and says so", () => {
    const r = resolveBrowserRung({ env: {}, platform: "darwin", detect: none });
    expect(r.mode).toBe("off");
    expect(r.reason).toMatch(/no Chrome, Brave, Chromium or Edge/);
  });

  it("is off on a Linux box with no display, even with a browser installed", () => {
    const r = resolveBrowserRung({ env: {}, platform: "linux", detect: brave });
    expect(r.mode).toBe("off");
    expect(r.reason).toMatch(/DISPLAY/);
  });

  it("is fallback on Linux once DISPLAY or WAYLAND_DISPLAY is set", () => {
    expect(resolveBrowserRung({ env: { DISPLAY: ":0" }, platform: "linux", detect: brave }).mode).toBe("fallback");
    expect(resolveBrowserRung({ env: { WAYLAND_DISPLAY: "wayland-0" }, platform: "linux", detect: brave }).mode).toBe("fallback");
  });

  it("is off, with the reason, when the named binary does not exist (detection throws)", () => {
    const r = resolveBrowserRung({
      env: {},
      platform: "darwin",
      detect: () => {
        throw new Error("ULTRASEARCH_BROWSER_BIN=/nope does not exist");
      },
    });
    expect(r.mode).toBe("off");
    expect(r.reason).toMatch(/\/nope does not exist/);
  });

  it("can show a window on macOS and Windows always, on Linux only with a display", () => {
    expect(canShowWindow("darwin", {})).toBe(true);
    expect(canShowWindow("win32", {})).toBe(true);
    expect(canShowWindow("linux", {})).toBe(false);
    expect(canShowWindow("linux", { DISPLAY: ":1" })).toBe(true);
  });
});

describe("resolveBrowserRung — overrides", () => {
  it("ULTRASEARCH_BROWSER_FETCH overrides the default, either way", () => {
    const off = resolveBrowserRung({ env: { ULTRASEARCH_BROWSER_FETCH: "off" }, platform: "darwin", detect: brave });
    expect(off).toMatchObject({ mode: "off", source: "env" });
    expect(off.reason).toMatch(/ULTRASEARCH_BROWSER_FETCH=off/);
    const always = resolveBrowserRung({ env: { ULTRASEARCH_BROWSER_FETCH: "ALWAYS" }, platform: "linux", detect: brave });
    expect(always).toMatchObject({ mode: "always", source: "env" });
  });

  it("an unrecognised env value reads as off, exactly as the engine reads it", () => {
    expect(resolveBrowserRung({ env: { ULTRASEARCH_BROWSER_FETCH: "yes" }, platform: "darwin", detect: brave }).mode).toBe("off");
  });

  it("the --browser flag overrides both the env and the default", () => {
    const r = resolveBrowserRung({ flag: "always", env: { ULTRASEARCH_BROWSER_FETCH: "off" }, platform: "darwin", detect: brave });
    expect(r).toMatchObject({ mode: "always", source: "flag" });
    const off = resolveBrowserRung({ flag: "off", env: {}, platform: "darwin", detect: brave });
    expect(off).toMatchObject({ mode: "off", source: "flag" });
    expect(off.reason).toMatch(/--browser off/);
  });

  it("the test setup forces the rung off, so no test can launch a browser", () => {
    expect(process.env.ULTRASEARCH_BROWSER_FETCH).toBe("off");
    expect(resolveBrowserRung().mode).toBe("off");
  });
});

describe("doctor — the browser row", () => {
  it("reports the binary and the mode when the rung is on", () => {
    const row = describeBrowserRung(resolveBrowserRung({ env: {}, platform: "darwin", detect: brave }));
    expect(row.name).toBe("browser");
    expect(row.ok).toBe(true);
    expect(row.detail).toMatch(/^fallback/);
    expect(row.detail).toContain("Brave Browser");
    expect(row.detail).toMatch(/--browser off/);
  });

  it("says why when the rung is off", () => {
    const row = describeBrowserRung(resolveBrowserRung({ env: {}, platform: "linux", detect: brave }));
    expect(row.ok).toBe(false);
    expect(row.detail).toMatch(/^off — .*DISPLAY/);
  });

  it("flags a rung forced on with no browser to run it", () => {
    const row = describeBrowserRung(resolveBrowserRung({ flag: "fallback", env: {}, platform: "darwin", detect: none }));
    expect(row.ok).toBe(false);
    expect(row.detail).toMatch(/no Chrome, Brave, Chromium or Edge/);
  });

  it("is a row of probeServices, right after firecrawl", async () => {
    const rows = await probeServices({}, ["firecrawl", "browser"]);
    expect(rows.map((r) => r.name)).toEqual(["firecrawl", "browser"]);
    expect(rows[1]!.detail).toMatch(/^off — ULTRASEARCH_BROWSER_FETCH=off/);
  });
});

describe("the run's accounting", () => {
  it("describeServices names the browser rung when it was on", () => {
    const base = { searxng: { requested: false, sources: 0 }, firecrawl: { pages: 0 }, pdf: {} };
    expect(describeServices({ ...base, browser: { mode: "fallback", pages: 3 } })).toContain("browser ✓ 3 page(s)");
    expect(describeServices({ ...base, browser: { mode: "fallback", pages: 0 } })).toContain("browser ✗ not used");
    expect(describeServices(base)).not.toContain("browser");
  });
});

describe("--browser on the CLI", () => {
  it("is a documented value flag", () => {
    expect(HELP).toMatch(/--browser <m>/);
  });

  it("is resolved once into the gather options, flag first", () => {
    expect(buildGatherOptions(parseCli(["gather", "--q", "x", "--browser", "always"])).browser).toBe("always");
    // No flag: the env (forced off by the test setup) decides.
    expect(buildGatherOptions(parseCli(["gather", "--q", "x"])).browser).toBe("off");
  });

  it("rejects an unknown mode", () => {
    const x = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const e = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      expect(() => buildGatherOptions(parseCli(["gather", "--q", "x", "--browser", "sometimes"]))).toThrow("exit:1");
    } finally {
      x.mockRestore();
      e.mockRestore();
    }
  });
});

describe("--browser on orchestrate", () => {
  it("threads an explicit mode into the gatherer's commands, and nothing when unset", () => {
    const run = mkdtempSync(join(tmpdir(), "us-orch-browser-"));
    try {
      writeFileSync(
        join(run, "PLAN.json"),
        JSON.stringify({
          question: "q",
          mode: "topic",
          subQuestions: [
            { id: "Q1", question: "a", queries: ["a"], out: join(run, "q1") },
            { id: "Q2", question: "b", queries: ["b"], out: join(run, "q2") },
          ],
        }),
      );
      emitOrchestration(run, "/engine.mjs", { phase: "gather" });
      const plain = readFileSync(join(run, "orchestration", "agents", "gatherer.md"), "utf8");
      expect(plain).not.toContain("--browser");
      emitOrchestration(run, "/engine.mjs", { phase: "gather", browser: "off" });
      const off = readFileSync(join(run, "orchestration", "agents", "gatherer.md"), "utf8");
      expect(off).toMatch(/gather --q .* --browser off/);
      expect(off).toMatch(/ingest --run .* --browser off/);
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  });
});

describe("--browser on the MCP tools", () => {
  it.each(["ultrasearch_gather", "ultrasearch_fetch", "ultrasearch_ingest", "ultrasearch_search"])("%s takes a browser mode", (name) => {
    const t = TOOLS.find((x) => x.name === name)!;
    const prop = t.inputSchema.properties.browser as { enum?: string[] } | undefined;
    expect(prop?.enum).toEqual(["always", "fallback", "off"]);
  });
});
