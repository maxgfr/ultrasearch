import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { probeServices, formatServices, describeServices, stackControl } from "../src/services.js";
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

  it("always reports the document ladder, and says when it is switched off", async () => {
    // tests/setup.ts pins ULTRASEARCH_DOC_ENGINE=none, which empties the ladder.
    // An empty ladder is not broken, but it does mean every office document a
    // run meets gets refused — the row has to say so rather than print nothing.
    const rows = await probeServices();
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName["doc ladder"]!.ok).toBe(false);
    expect(byName["doc ladder"]!.detail).toMatch(/refused, not read/);
    expect(byName.anydoc!.ok).toBe(false);
    expect(byName.anydoc!.detail).toMatch(/skipped/i);
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
      doc: { anydoc: 2 },
    });
    expect(line).toContain("searxng ✓ 12 result(s)");
    expect(line).toContain("firecrawl ✓ 8 page(s)");
    expect(line).toContain("pdf-inspector ✓ 3");
    expect(line).toContain("doc anydoc ✓ 2");
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
  // The compose file is embedded in the engine, so these cover the wiring this
  // repo still owns: that the delegation happens at all, and that a machine
  // without Docker gets an answer rather than a stack trace. The orchestration
  // itself (pull-then-up, --wait, the model pull) is the engine's, and tested
  // there against a fake docker.

  it("drives the engine's embedded stack, so an installed copy works too", () => {
    // The previous version looked for docker-compose.yml beside the bundle and
    // gave up when it was not there — which is every install that is not a
    // clone. There is no such file in this repo any more.
    const calls: string[][] = [];
    const r = stackControl("searxng", "up", {
      has: () => true,
      run: (cmd, args) => (calls.push([cmd, ...args]), { ok: true, stdout: "", stderr: "" }),
    });
    expect(r.code).toBe(0);
    const file = calls[0]![calls[0]!.indexOf("-f") + 1]!;
    expect(file).toMatch(/docker-compose\.yml$/);
    expect(existsSync(file)).toBe(true); // materialised on demand
  });

  // Firecrawl delegates its keyless /search to SearXNG, so bringing it up has to
  // bring that profile too.
  it("brings SearXNG up alongside Firecrawl", () => {
    const calls: string[][] = [];
    stackControl("firecrawl", "up", { has: () => true, run: (c, a) => (calls.push([c, ...a]), { ok: true, stdout: "", stderr: "" }) });
    expect(calls[0]).toEqual(expect.arrayContaining(["--profile", "search", "--profile", "extract"]));
  });

  it("says docker is missing instead of throwing", () => {
    const r = stackControl("searxng", "down", { has: () => false });
    expect(r.code).not.toBe(0);
    expect(r.message).toContain("docker not found");
    // The brand reaches the engine: this is ultrasearch's message, not webindex's.
    expect(r.message.startsWith("ultrasearch searxng:")).toBe(true);
  });
});
