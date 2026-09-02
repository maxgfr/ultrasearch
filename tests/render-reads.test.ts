import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// readDossier is wrapped in a spy so the number of dossier reads a render pair
// performs is observable: html + markdown must share ONE load, not do two.
vi.mock("../src/dossier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/dossier.js")>();
  return { ...actual, readDossier: vi.fn(actual.readDossier) };
});

import { readDossier } from "../src/dossier.js";
import { loadRenderContext, writeHtml, writeReportMarkdown } from "../src/render.js";
import { writeFixtureDossier } from "./dossierfix.js";

const reads = readDossier as unknown as ReturnType<typeof vi.fn>;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "us-render-reads-"));
  writeFixtureDossier(dir, 2);
  writeFileSync(join(dir, "SUMMARY.md"), "## TL;DR\nA summary of request windows citing [S1].\n");
  writeFileSync(join(dir, "REPORT.md"), "# R\nA grounded factual claim about request windows here [S2].\n");
  writeFileSync(join(dir, "glossary.md"), "## Terms\n- **window**: a period of time, see [S1].\n");
  writeFileSync(
    join(dir, "VERIFY.json"),
    JSON.stringify({
      ok: true,
      pairs: 1,
      adjudicated: 1,
      supported: 1,
      partial: 0,
      refuted: 0,
      unsupported: 0,
      failures: [],
      unadjudicated: [],
      verdicts: [{ claimId: "C1", file: "REPORT.md", sourceId: "S2", claim: "a claim", verdict: "supported", note: "" }],
    }),
  );
  reads.mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("render read amplification", () => {
  it("loads the dossier once for the html + markdown pair when they share a context", () => {
    const ctx = loadRenderContext(dir);
    writeHtml(ctx);
    writeReportMarkdown(ctx);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("still loads the dossier per call when each writer is handed the directory", () => {
    writeHtml(dir);
    writeReportMarkdown(dir);
    expect(reads).toHaveBeenCalledTimes(2);
  });
});
