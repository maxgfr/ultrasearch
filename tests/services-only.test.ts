import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeServices } from "../src/services.js";
import { runWithInput } from "../src/backends/exec.js";

// `doctor` wants every row; `gather --search max` wants two; `searxng status`
// wants one. Probing all eight to print one line costs an npx spawn (and a
// container round-trip) nobody asked for, so probeServices takes an `only`
// filter and runs what is left in parallel.
//
// The probes are stubbed at the subprocess seam, the same way and for the same
// reason as tests/services-doc.test.ts: against a real npx these rows would say
// "via npx" on a laptop and "unavailable" on a Node 18 runner, so the suite
// could only ever have asserted their shape — and it must stay offline
// (CONTRIBUTING.md, rule 3).
vi.mock("../src/backends/exec.js", () => ({
  runWithInput: vi.fn(async () => ({ ok: false, stdout: "", error: "not installed" })),
  PDF_INSPECTOR_SPEC: "@firecrawl/pdf-inspector@1",
  ANYDOC_SPEC: "@firecrawl/anydoc@0.1",
}));
const runMock = vi.mocked(runWithInput);

const PROBE_MS = 50;

/** Which probe a spawn belongs to — both npx rungs share the binary. */
const probeName = (cmd: string, args: string[]) => (cmd !== "npx" ? cmd : args.some((a) => a.includes("pdf-inspector")) ? "pdf-inspector" : "anydoc");

let log: string[] = [];

beforeEach(() => {
  log = [];
  // Both npx rungs on, OCR off. OCR's two probes live in the engine, BELOW this
  // module mock, so leaving that rung enabled would spawn copyable-pdf and
  // tesseract for real. Pinning the PDF ladder to its npx rung gives exactly
  // three subprocess probes: pdf-inspector, pdftotext, anydoc.
  vi.stubEnv("ULTRASEARCH_PDF_ENGINE", "pdf-inspector");
  vi.stubEnv("ULTRASEARCH_DOC_ENGINE", "anydoc");
  runMock.mockImplementation(async (cmd, args) => {
    log.push(`start ${probeName(cmd, args)}`);
    await new Promise((r) => setTimeout(r, PROBE_MS));
    log.push(`end ${probeName(cmd, args)}`);
    return { ok: true, stdout: "1.0.0\n" };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  runMock.mockReset();
  runMock.mockResolvedValue({ ok: false, stdout: "", error: "not installed" });
});

const ALL_ROWS = ["searxng", "firecrawl", "pdf-inspector", "pdftotext", "ocr", "pdf ladder", "anydoc", "doc ladder"];

describe("probeServices — the `only` filter", () => {
  // `formatServices` pads the name column to the widest name IN THE ARRAY it is
  // handed, so a reordered array is a differently-indented `doctor`. The filter
  // narrows the rows; it never reorders them.
  it("returns only the asked-for rows, in the fixed doctor order, byte for byte", async () => {
    const full = await probeServices();
    expect(full.map((r) => r.name)).toEqual(ALL_ROWS);

    // Asked for firecrawl-first; still answers searxng-first.
    const rows = await probeServices({}, ["firecrawl", "searxng"]);
    expect(rows.map((r) => r.name)).toEqual(["searxng", "firecrawl"]);
    expect(rows).toEqual(full.filter((r) => r.name === "searxng" || r.name === "firecrawl"));
  });

  it("spawns nothing for the rows it was not asked about", async () => {
    const rows = await probeServices({}, ["pdftotext"]);
    expect(rows.map((r) => r.name)).toEqual(["pdftotext"]);
    // One spawn, and not an npx one: this is the whole point of the filter.
    expect(runMock.mock.calls.map((c) => c[0])).toEqual(["pdftotext"]);
  });

  it("still probes an npx rung asked for on its own", async () => {
    const rows = await probeServices({}, ["anydoc"]);
    expect(rows.map((r) => r.name)).toEqual(["anydoc"]);
    expect(rows[0]!.detail).toBe("1.0.0 (via npx)");
    expect(runMock).toHaveBeenCalledTimes(1);
  });
});

describe("probeServices — the probes run in parallel", () => {
  // Three probes of 50 ms each. Sequentially that is 150 ms; in parallel it is
  // 100 ms, because the two npx probes are deliberately serialised with each
  // other. Fake timers make the bound a fact rather than a race with CI load.
  it("finishes three 50 ms probes well inside the sequential 150 ms", async () => {
    vi.useFakeTimers();
    let done = false;
    const p = probeServices().then((rows) => {
      done = true;
      return rows;
    });
    await vi.advanceTimersByTimeAsync(120);
    expect(done).toBe(true);
    // …and the parallel assembly still hands back the fixed order.
    expect((await p).map((r) => r.name)).toEqual(ALL_ROWS);
  });

  // Both npx rungs install into npm's shared `_npx` cache directory, where two
  // concurrent installs can wedge on the same lock. They are serialised with
  // each other — and only with each other.
  it("never runs the two npx probes at once, but overlaps them with the rest", async () => {
    vi.useFakeTimers();
    const p = probeServices();
    await vi.advanceTimersByTimeAsync(500);
    await p;

    expect(log).toContain("start anydoc");
    expect(log.indexOf("start anydoc")).toBeGreaterThan(log.indexOf("end pdf-inspector"));
    // pdftotext is not an npx probe: it must not wait behind them.
    expect(log.indexOf("start pdftotext")).toBeLessThan(log.indexOf("end pdf-inspector"));
  });

  // The subprocess seam promises never to throw, so this is a contract
  // violation — and it must fail the way the old sequential code failed
  // (rejecting), not be quietly swallowed into an "unavailable" row.
  it("propagates a subprocess seam that throws, rather than swallowing it", async () => {
    runMock.mockImplementation(async (cmd, args) => {
      if (probeName(cmd, args) === "pdf-inspector") throw new Error("spawn exploded");
      return { ok: true, stdout: "1.0.0\n" };
    });
    await expect(probeServices()).rejects.toThrow("spawn exploded");
  });
});
