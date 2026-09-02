import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFixtureDossier } from "./dossierfix.js";

// This suite counts how many times `check` reads a cited source extract, so it
// mocks the dossier module. Keep it in its own file: the mock is module-wide
// and must not leak into the rest of the check tests.
vi.mock("../src/dossier.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/dossier.js")>();
  return { ...mod, readSourceText: vi.fn(mod.readSourceText) };
});

import { runCheck } from "../src/check.js";
import { readSourceText } from "../src/dossier.js";

const readMock = vi.mocked(readSourceText);

// A dossier exercising every extract state the two consumers (the "wall" scan
// and the numeral pass) can meet, each cited by a claim carrying a numeral so
// BOTH consumers want the same file:
//   S1 readable extract that carries the figure   -> read, no issue
//   S2 anti-bot wall, figure absent               -> read, wall warning + issue
//   S3 extract file missing                       -> never read (UNKNOWN)
//   S4 extract path is a directory (unreadable)   -> read attempt throws (UNKNOWN)
//   S5 never cited                                -> never read
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "us-check-reads-"));
  writeFixtureDossier(dir, 5);
  writeFileSync(join(dir, "sources/S1.md"), "# S1\nThe cache hit rate reached 87 percent in production.\n");
  writeFileSync(join(dir, "sources/S2.md"), "# S2\nChecking your browser before accessing example.test.\n");
  rmSync(join(dir, "sources/S3.md"));
  rmSync(join(dir, "sources/S4.md"));
  mkdirSync(join(dir, "sources/S4.md"));
  writeFileSync(
    join(dir, "REPORT.md"),
    [
      "# Numbers",
      "",
      "The cache hit rate reached 87 percent across the whole fleet [S1].",
      "",
      "Throughput rose to 4200 requests per second at the edge tier [S2].",
      "",
      "Median latency dropped to 12 milliseconds under steady load [S3].",
      "",
      "The index grew to 950 documents over the course of the run [S4].",
      "",
    ].join("\n"),
  );
  return dir;
}

describe("runCheck — extract reads", () => {
  it("reads each cited extract exactly once", () => {
    const dir = fixture();
    readMock.mockClear();
    runCheck(dir);
    // The distinct cited extracts that exist on disk: S1, S2 and the S4
    // directory (S3's file is missing, S5 is uncited).
    const reads = readMock.mock.calls.map((c) => c[1]!.id).sort();
    expect(reads).toEqual(["S1", "S2", "S4"]);
    expect(readMock).toHaveBeenCalledTimes(3);
    rmSync(dir, { recursive: true, force: true });
  });

  it("produces the same CheckResult (byte-identity oracle)", () => {
    const dir = fixture();
    const r = runCheck(dir);
    expect(r).toMatchInlineSnapshot(`
      {
        "dangling": [],
        "errors": [],
        "filesChecked": [
          "REPORT.md",
        ],
        "modelHints": 0,
        "numeralIssues": [
          {
            "claim": "Throughput rose to 4200 requests per second at the edge tier [S2].",
            "file": "REPORT.md",
            "numeral": "4200",
            "sourceIds": [
              "S2",
            ],
          },
        ],
        "ok": true,
        "sourceCitations": 4,
        "uncitedSources": [
          "S5",
        ],
        "unknownTokens": [],
        "unmarkedUnsourced": [],
        "warnings": [
          "1 source(s) were never cited (informational).",
          "1 cited source(s) extracted to a wall, not content: S2 (anti-bot interstitial). Re-\`fetch --url\` them (the page may have been throttling) or drop the claims that rest on them.",
          "1 numeral(s) in cited claim(s) not found in any cited source extract (e.g. "4200" cited to S2). Verify the attribution, \`fetch --url\` the page that carries the figure, or flag it [M].",
        ],
      }
    `);
    rmSync(dir, { recursive: true, force: true });
  });
});
