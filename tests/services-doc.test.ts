import { afterEach, describe, expect, it, vi } from "vitest";
import { probeServices } from "../src/services.js";
import { runWithInput } from "../src/backends/pdf/exec.js";

// Probing anydoc means spawning `npx`, which on a cold machine is a network
// download — and the suite stays offline and deterministic (CONTRIBUTING.md,
// rule 3). Stubbing the subprocess layer is also what makes the VERDICT
// assertable: against a real npx these rows would say "via npx" on a developer's
// laptop and "unavailable" on a Node 18 CI runner, so the test could only ever
// have checked their shape.
//
// This lives apart from tests/services.test.ts so the module mock does not
// silence the pdftotext probe that file deliberately runs for real.
vi.mock("../src/backends/pdf/exec.js", () => ({
  runWithInput: vi.fn(async () => ({ ok: false, stdout: "", error: "not installed" })),
  // Re-exported verbatim: the pinned specs are plain constants, and the code
  // under test reads them to build argv.
  PDF_INSPECTOR_SPEC: "@firecrawl/pdf-inspector@1",
  ANYDOC_SPEC: "@firecrawl/anydoc@0.1",
}));
const runMock = vi.mocked(runWithInput);

afterEach(() => {
  vi.unstubAllEnvs();
  runMock.mockReset();
  runMock.mockResolvedValue({ ok: false, stdout: "", error: "not installed" });
});

const rowsByName = async () => Object.fromEntries((await probeServices()).map((r) => [r.name, r]));

describe("probeServices — the document converter", () => {
  it("reports the version when anydoc answers", async () => {
    vi.stubEnv("ULTRASEARCH_DOC_ENGINE", "anydoc");
    runMock.mockResolvedValue({ ok: true, stdout: "0.1.7\n" });
    const byName = await rowsByName();
    expect(byName["doc ladder"]!.ok).toBe(true);
    expect(byName["doc ladder"]!.detail).toBe("anydoc");
    expect(byName.anydoc!.ok).toBe(true);
    expect(byName.anydoc!.detail).toBe("0.1.7 (via npx)");
  });

  // anydoc needs Node 20+, one version above this package's own floor, so an
  // absent converter is a normal outcome rather than a misconfiguration. The row
  // has to say what would fix it without implying something is broken.
  it("explains what is missing when anydoc does not answer", async () => {
    vi.stubEnv("ULTRASEARCH_DOC_ENGINE", "anydoc");
    const byName = await rowsByName();
    expect(byName.anydoc!.ok).toBe(false);
    expect(byName.anydoc!.detail).toMatch(/needs npm, Node 20\+/);
  });
});
