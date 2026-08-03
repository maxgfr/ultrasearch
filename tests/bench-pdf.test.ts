import { describe, expect, it, vi, beforeEach } from "vitest";
import { extractPdf, resetPdfLadderCache } from "../src/backends/pdf.js";

// What each PDF rung actually delivers, on real papers. Network by design, so it
// is OFF unless ULTRASEARCH_BENCH=1 (`pnpm run bench:pdf`) and never gates CI.
//
// Two metrics carry the weight, both learned from real failures:
//
//   witness  a sentence the built-in reader used to MUTILATE. Its TJ-array
//            tokenizer stopped at a "]" inside a string, so "[13] and gated
//            recurrent [7]" collapsed to "[ 13 7" — deleting whole clauses while
//            leaving fluent, citable prose behind. Only an exact-match check
//            catches that: the damage is invisible by inspection.
//
//   control  share of C0/C1 bytes. The built-in reader mines any stream
//            containing `Tj`, so image and font data comes out as text — 16 MB
//            of it for a 12 MB paper, at 4.5e-2 to 1.7e-1. Clean extractors sit
//            at 0 – 4.0e-4, which is what the quality gate is calibrated on.

const CASES = [
  {
    id: "arxiv-2col",
    url: "https://arxiv.org/pdf/1706.03762",
    witness: "long short-term memory [13] and gated recurrent [7] neural networks",
  },
  { id: "arxiv-math", url: "https://arxiv.org/pdf/2404.19756", witness: "Kolmogorov" },
] as const;

const RUNGS = ["pdf-inspector", "pdftotext", "native"] as const;

function controlRatio(t: string): number {
  if (!t.length) return 0;
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c !== 9 && c !== 10 && c !== 13 && (c < 32 || (c >= 127 && c <= 159))) n++;
  }
  return n / t.length;
}

describe.skipIf(!process.env.ULTRASEARCH_BENCH)("PDF extractor ladder — bench", () => {
  beforeEach(() => {
    // The suite pins the ladder to `native` for determinism; a bench wants the
    // real thing.
    vi.stubEnv("ULTRASEARCH_PDF_ENGINE", undefined);
    resetPdfLadderCache();
  });

  const rows: string[] = [];

  for (const c of CASES) {
    it(`${c.id}`, { timeout: 600_000 }, async () => {
      const res = await fetch(c.url, { headers: { accept: "application/pdf,*/*", "user-agent": "Mozilla/5.0" } });
      expect(res.ok, `could not fetch ${c.url}`).toBe(true);
      const bytes = Buffer.from(await res.arrayBuffer());

      for (const rung of RUNGS) {
        resetPdfLadderCache();
        const t0 = Date.now();
        // Pin ONE rung so each is measured on its own; production falls through.
        const out = await extractPdf(bytes, { engines: [rung] });
        const ms = Date.now() - t0;
        const kept = !!out.via;
        rows.push(
          `  ${c.id.padEnd(11)} ${rung.padEnd(14)} kept=${(kept ? "yes" : "no").padEnd(4)} chars=${String(out.text.length).padStart(7)} ` +
            `control=${controlRatio(out.text).toExponential(1).padStart(8)} witness=${out.text.includes(c.witness) ? "intact" : "ABSENT"} ${ms}ms` +
            (out.reason ? `  (${out.reason})` : ""),
        );

        // The gate must never accept text with the witness sentence missing —
        // that would be exactly the silent loss it exists to prevent.
        if (kept) expect(out.text.includes(c.witness), `${c.id}/${rung} passed the gate but lost the witness sentence`).toBe(true);
      }

      // eslint-disable-next-line no-console
      console.log("\n" + rows.join("\n") + "\n");
    });
  }
});
