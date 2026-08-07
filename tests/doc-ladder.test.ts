import { describe, it, expect, afterEach, vi } from "vitest";
import { extractDocument, enabledDocExtractors, resetDocLadderCache } from "../src/backends/doc.js";
import { runWithInput } from "../src/backends/pdf/exec.js";

// The anydoc rung spawns `npx`, which on a cold machine is a network download —
// the suite stays offline and deterministic (CONTRIBUTING.md, rule 3), so the
// subprocess layer is stubbed here. `tests/pdf-exec.test.ts` is what proves
// runWithInput itself works, against `node` rather than a package from a
// registry.
vi.mock("../src/backends/pdf/exec.js", () => ({
  runWithInput: vi.fn(async () => ({ ok: false, stdout: "", error: "not installed" })),
}));
const runMock = vi.mocked(runWithInput);

const BINARY = { textFallback: false };
const BYTES = Buffer.from("PK pretend this is a .docx", "latin1");

afterEach(() => {
  vi.unstubAllEnvs();
  resetDocLadderCache();
  runMock.mockReset();
  runMock.mockResolvedValue({ ok: false, stdout: "", error: "not installed" });
});

describe("enabledDocExtractors", () => {
  it("defaults to the full ladder, strongest first", () => {
    vi.stubEnv("ULTRASEARCH_DOC_ENGINE", undefined);
    expect(enabledDocExtractors()).toEqual(["anydoc", "firecrawl"]);
  });

  it("honours ULTRASEARCH_DOC_ENGINE by running exactly that rung", () => {
    vi.stubEnv("ULTRASEARCH_DOC_ENGINE", "firecrawl");
    expect(enabledDocExtractors()).toEqual(["firecrawl"]);
  });

  // `none` has no counterpart in the PDF ladder because that one always has a
  // built-in last rung. This one does not, so it needs a way to be switched off.
  it("empties the ladder on ULTRASEARCH_DOC_ENGINE=none", () => {
    vi.stubEnv("ULTRASEARCH_DOC_ENGINE", "none");
    expect(enabledDocExtractors()).toEqual([]);
  });

  it("drops the rung that needs an implicit install under ULTRASEARCH_NO_NPX", () => {
    vi.stubEnv("ULTRASEARCH_DOC_ENGINE", undefined);
    vi.stubEnv("ULTRASEARCH_NO_NPX", "1");
    expect(enabledDocExtractors()).toEqual(["firecrawl"]);
  });

  it("ignores an unknown engine name rather than emptying the ladder", () => {
    vi.stubEnv("ULTRASEARCH_DOC_ENGINE", "nope");
    expect(enabledDocExtractors()).toEqual(["anydoc", "firecrawl"]);
  });

  it("lets an explicit engines list win over the environment", () => {
    vi.stubEnv("ULTRASEARCH_DOC_ENGINE", "none");
    expect(enabledDocExtractors(["firecrawl"])).toEqual(["firecrawl"]);
  });
});

describe("extractDocument", () => {
  it("returns the Firecrawl rung's markdown when it is the only rung", async () => {
    const r = await extractDocument(BYTES, BINARY, {
      engines: ["firecrawl"],
      firecrawl: async () => "# Quarterly report\n\nReal prose from the container.",
    });
    expect(r.via).toBe("firecrawl");
    expect(r.text).toContain("Quarterly report");
  });

  it("refuses — with a reason — when no rung is available", async () => {
    const r = await extractDocument(BYTES, BINARY, { engines: [] });
    expect(r.text).toBe("");
    expect(r.via).toBeUndefined();
    expect(r.reason).toMatch(/no document converter available/);
  });

  it("refuses when a rung is present but has no container behind it", async () => {
    const r = await extractDocument(BYTES, BINARY, { engines: ["firecrawl"] });
    expect(r.text).toBe("");
    expect(r.reason).toMatch(/no document converter available/);
  });

  // The gate that makes this ladder worth having: a rung that hands back the
  // undecoded ZIP must be rejected, not cited.
  it("rejects a rung whose output is the raw bytes rather than text", async () => {
    const mojibake = BYTES.toString("utf8").repeat(80);
    const r = await extractDocument(BYTES, BINARY, {
      engines: ["firecrawl"],
      firecrawl: async () => mojibake,
    });
    expect(r.text).toBe("");
    expect(r.reason).toBeDefined();
  });

  it("reports an empty conversion as a reason instead of an empty success", async () => {
    const r = await extractDocument(BYTES, BINARY, { engines: ["firecrawl"], firecrawl: async () => "   " });
    expect(r.text).toBe("");
    expect(r.reason).toMatch(/produced no text/);
  });

  it("never lets a throwing rung take the run down", async () => {
    const r = await extractDocument(BYTES, BINARY, {
      engines: ["firecrawl"],
      firecrawl: async () => {
        throw new Error("container exploded");
      },
    });
    expect(r.text).toBe("");
    expect(r.reason).toMatch(/no document converter available/);
  });

  it("converts through the anydoc rung when it answers", async () => {
    runMock.mockResolvedValue({ ok: true, stdout: "# Quarterly report\n\nReal prose from the converter.\n" });
    const r = await extractDocument(BYTES, BINARY, { engines: ["anydoc"] });
    expect(r.via).toBe("anydoc");
    expect(r.text).toContain("Quarterly report");
  });

  // The document travels on stdin and the format comes from the table in
  // formats.ts — nothing derived from a URL may reach argv.
  it("passes the document on stdin, and names a format only when the table does", async () => {
    runMock.mockResolvedValue({ ok: true, stdout: "converted" });
    await extractDocument(BYTES, BINARY, { engines: ["anydoc"] });
    const [cmd, args, input] = runMock.mock.calls[0]!;
    expect(cmd).toBe("npx");
    expect(args).toEqual(["-y", "--prefer-offline", "@firecrawl/anydoc", "-"]);
    expect(input).toBe(BYTES);

    runMock.mockClear();
    await extractDocument(BYTES, { format: "csv", textFallback: true }, { engines: ["anydoc"] });
    expect(runMock.mock.calls[0]![1]).toEqual(["-y", "--prefer-offline", "@firecrawl/anydoc", "-", "--format", "csv"]);
  });

  it("falls through a failed rung to the next one", async () => {
    // anydoc reports itself unavailable, so firecrawl — the rung after it — is
    // what answers.
    const r = await extractDocument(BYTES, BINARY, {
      engines: ["anydoc", "firecrawl"],
      firecrawl: async () => "# Rescued\n\nThe second rung read it.",
    });
    expect(r.via).toBe("firecrawl");
    expect(r.text).toContain("Rescued");
  });

  // Without this memo a 40-source run would re-pay the same npx discovery for
  // every single document it meets.
  it("stops retrying a rung that was found unavailable", async () => {
    await extractDocument(BYTES, BINARY, { engines: ["anydoc"] });
    await extractDocument(BYTES, BINARY, { engines: ["anydoc"] });
    expect(runMock).toHaveBeenCalledTimes(1);
  });
});
