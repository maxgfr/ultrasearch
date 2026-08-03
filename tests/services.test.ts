import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { probeServices, formatServices, describeServices, composeFile, compose, SERVICE_PROFILES } from "../src/services.js";
import { resetSearxngProbeCache } from "../src/backends/searxng.js";
import { installFetchMock } from "./fetchmock.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetSearxngProbeCache();
});

// Every optional helper is skipped in SILENCE when absent — right for a per-URL
// note, wrong once per run, because it lets a container sit up for weeks without
// ever being queried and without anything saying so. These are the surfaces that
// break that silence, so they are worth holding to their wording.

// Firecrawl memoises its availability probe per base for the whole process (and
// exposes no reset), so every case that needs a different verdict gets its own
// base URL — the same convention as tests/backends-firecrawl.test.ts.
let n = 0;
const nextFc = () => `http://fc-svc${++n}.test`;

describe("probeServices", () => {
  it("reports both containers as disabled when they are turned off", async () => {
    // tests/setup.ts already pins both to "off".
    const rows = await probeServices();
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.searxng!.ok).toBe(false);
    expect(byName.searxng!.detail).toMatch(/disabled/i);
    expect(byName.firecrawl!.ok).toBe(false);
    expect(byName.firecrawl!.detail).toMatch(/disabled/i);
  });

  it("reports a container that answers, and where", async () => {
    installFetchMock(() => ({ status: 200, body: "ok" }));
    const rows = await probeServices({ searxng: "http://sx.test", firecrawl: nextFc() });
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.searxng).toMatchObject({ ok: true });
    expect(byName.searxng!.detail).toContain("http://sx.test");
    expect(byName.firecrawl).toMatchObject({ ok: true });
  });

  it("tells you how to start a container that is not running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string) => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const rows = await probeServices({ searxng: "http://sx.test", firecrawl: nextFc() });
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.searxng!.ok).toBe(false);
    expect(byName.searxng!.detail).toMatch(/searxng up/);
    expect(byName.firecrawl!.detail).toMatch(/firecrawl up/);
  });

  it("always reports the PDF ladder, and says when a rung was opted out of", async () => {
    // tests/setup.ts pins ULTRASEARCH_PDF_ENGINE=native, so the npx rung is out.
    const rows = await probeServices();
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName["pdf ladder"]!.detail).toBe("native");
    expect(byName["pdf-inspector"]!.ok).toBe(false);
    expect(byName["pdf-inspector"]!.detail).toMatch(/skipped/i);
    // pdftotext's presence depends on the machine, so only its row is asserted.
    expect(byName.pdftotext).toBeDefined();
  });
});

describe("formatServices", () => {
  it("marks each row and aligns the names into a readable column", () => {
    const out = formatServices([
      { name: "searxng", ok: true, detail: "answering at http://localhost:8888" },
      { name: "firecrawl", ok: false, detail: "not running" },
    ]);
    expect(out).toContain("✓ searxng");
    expect(out).toContain("✗ firecrawl");
    // padded to the longest name, so the details line up
    expect(out).toMatch(/✓ searxng {3}/);
  });
});

describe("describeServices", () => {
  it("says what each helper actually contributed", () => {
    const line = describeServices({
      searxng: { requested: true, sources: 12 },
      firecrawl: { pages: 8 },
      pdf: { "pdf-inspector": 3 },
    });
    expect(line).toContain("searxng ✓ 12 result(s)");
    expect(line).toContain("firecrawl ✓ 8 page(s)");
    expect(line).toContain("pdf-inspector ✓ 3");
  });

  // The case the line exists for: a container that is up and contributed
  // nothing must say so, not stay quiet.
  it("says so explicitly when a helper contributed nothing", () => {
    const line = describeServices({ searxng: { requested: true, sources: 0 }, firecrawl: { pages: 0 }, pdf: {} });
    expect(line).toContain("searxng ✗ no results");
    expect(line).toContain("firecrawl ✗ not used");
    expect(line).toContain("doctor");
  });

  it("distinguishes 'not requested' from 'requested and empty'", () => {
    const line = describeServices({ searxng: { requested: false, sources: 0 }, firecrawl: { pages: 0 }, pdf: {} });
    expect(line).toContain("not in this mode's backends");
  });
});

describe("container lifecycle", () => {
  it("finds the compose file from the engine's location", () => {
    const p = composeFile();
    expect(p).toBeDefined();
    expect(existsSync(p!)).toBe(true);
  });

  // Firecrawl delegates its keyless /search to SearXNG, so bringing it up has to
  // bring that profile too.
  it("brings SearXNG up alongside Firecrawl", () => {
    expect(SERVICE_PROFILES.firecrawl).toContain("search");
    expect(SERVICE_PROFILES.firecrawl).toContain("extract");
    expect(SERVICE_PROFILES.searxng).toEqual(["search"]);
  });

  it("fails with a non-zero code instead of throwing when docker is absent", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // Point PATH at nothing so `docker` cannot resolve — the ENOENT branch.
    vi.stubEnv("PATH", "/nonexistent-ultrasearch-test");
    const code = await compose("searxng", "down");
    expect(code).not.toBe(0);
    stderr.mockRestore();
  });
});
