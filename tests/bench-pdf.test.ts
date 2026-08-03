import { describe, expect, it, vi, beforeEach } from "vitest";
import { extractPdf, resetPdfLadderCache } from "../src/backends/pdf.js";
import { scrapeViaFirecrawl } from "../src/backends/firecrawl.js";

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

// Firecrawl is included so the container rung is measured too — it is the one
// that covers the platforms npm has no pdf-inspector binary for. With the stack
// down it simply reports `kept=no`, which is the honest answer rather than a
// silent gap in the table.
const RUNGS = ["pdf-inspector", "firecrawl", "pdftotext", "native"] as const;

// tests/setup.ts pins ULTRASEARCH_FIRECRAWL=off for the whole suite (a stubbed
// fetch would otherwise make the probe succeed everywhere). A bench wants the
// real container, so it carries its own base.
const FIRECRAWL_BASE = process.env.ULTRASEARCH_BENCH_FIRECRAWL || "http://localhost:3002";

// Rungs that emit Markdown escape their brackets — Firecrawl returns
// `\[13\] and gated recurrent \[7\]` for the witness sentence. That is the SAME
// text, so comparing it raw would report a perfectly healthy extractor as having
// lost the sentence. Normalise the escaping (and whitespace, since `-layout`
// wraps lines) before matching, so the check only fires on real text loss.
function normalize(t: string): string {
  return t.replace(/\\([[\]()*_`#+\-.!])/g, "$1").replace(/\s+/g, " ");
}

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
        const out = await extractPdf(bytes, {
          engines: [rung],
          firecrawl: async () => {
            const fc = await scrapeViaFirecrawl(c.url, { firecrawl: FIRECRAWL_BASE });
            return fc.data && (fc.data.statusCode ?? 200) < 400 ? fc.data.markdown : undefined;
          },
        });
        const ms = Date.now() - t0;
        const kept = !!out.via;
        rows.push(
          `  ${c.id.padEnd(11)} ${rung.padEnd(14)} kept=${(kept ? "yes" : "no").padEnd(4)} chars=${String(out.text.length).padStart(7)} ` +
            `control=${controlRatio(out.text).toExponential(1).padStart(8)} witness=${normalize(out.text).includes(normalize(c.witness)) ? "intact" : "ABSENT"} ${ms}ms` +
            (out.reason ? `  (${out.reason})` : ""),
        );

        // The gate must never accept text with the witness sentence missing —
        // that would be exactly the silent loss it exists to prevent.
        if (kept) expect(normalize(out.text).includes(normalize(c.witness)), `${c.id}/${rung} passed the gate but lost the witness sentence`).toBe(true);
      }

      // eslint-disable-next-line no-console
      console.log("\n" + rows.join("\n") + "\n");
    });
  }
});
