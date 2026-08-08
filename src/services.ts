import { runWithInput, ANYDOC_SPEC, PDF_INSPECTOR_SPEC } from "./backends/exec.js";
import { firecrawlBase, firecrawlIsExplicit, probeFirecrawl } from "./backends/firecrawl.js";
import { probeSearxng } from "./backends/searxng.js";
import { searxngBase } from "./engine.js";
import { enabledExtractors, ocrTools, ocrBudgetLeft } from "./backends/pdf.js";
import { enabledDocExtractors } from "./backends/doc.js";
import type { ManifestServices } from "./types.js";

// What the optional helpers are doing right now, and how to start them.
//
// Everything ultrasearch can lean on — the SearXNG and Firecrawl containers, the
// pdf-inspector and pdftotext extractors — is optional and skipped in silence
// when absent. That silence is right per URL (a note on every page would drown
// the dossier) and wrong once per run: a container could sit up for weeks
// without ever being queried and nothing would say so. `doctor` is the answer.

export interface ServiceStatus {
  name: string;
  ok: boolean;
  /** One line: where it is / why it isn't, and what to do about it. */
  detail: string;
}

const VERSION_PROBE_TIMEOUT_MS = 20_000;

async function toolVersion(cmd: string, args: string[]): Promise<string | undefined> {
  const r = await runWithInput(cmd, args, Buffer.alloc(0), VERSION_PROBE_TIMEOUT_MS);
  if (!r.ok) return undefined;
  return r.stdout.trim().split("\n")[0]?.trim() || "installed";
}

/**
 * Probe every optional service and extractor. Never throws; a probe that cannot
 * answer is reported as unavailable, which is exactly how a run treats it.
 */
export async function probeServices(opts: { firecrawl?: string; searxng?: string } = {}): Promise<ServiceStatus[]> {
  const out: ServiceStatus[] = [];

  const sxBase = searxngBase({ searxng: opts.searxng });
  if (!sxBase) out.push({ name: "searxng", ok: false, detail: "disabled (--searxng off)" });
  else {
    const up = await probeSearxng(sxBase);
    out.push({
      name: "searxng",
      ok: up,
      detail: up ? `answering at ${sxBase}` : `not running at ${sxBase} — \`ultrasearch searxng up\``,
    });
  }

  const fcBase = firecrawlBase(opts);
  if (!fcBase) out.push({ name: "firecrawl", ok: false, detail: "disabled (--firecrawl off)" });
  else {
    const explicit = firecrawlIsExplicit(opts);
    const up = await probeFirecrawl(fcBase, explicit);
    out.push({
      name: "firecrawl",
      ok: up,
      detail: up
        ? `answering at ${fcBase}`
        : // Distinguish "nothing there" from "something there, but not Firecrawl" —
          // a squatted port is a confusing failure to debug without being told.
          `not running at ${fcBase}${explicit ? "" : " (or the port is held by another app)"} — \`ultrasearch firecrawl up\``,
    });
  }

  const rungs = enabledExtractors();
  if (rungs.includes("pdf-inspector")) {
    const v = await toolVersion("npx", ["-y", "--prefer-offline", PDF_INSPECTOR_SPEC, "--version"]);
    out.push({
      name: "pdf-inspector",
      ok: !!v,
      detail: v ? `${v} (via npx)` : "unavailable — needs npm, and a prebuilt binary for this platform",
    });
  } else {
    out.push({ name: "pdf-inspector", ok: false, detail: "skipped (ULTRASEARCH_NO_NPX / ULTRASEARCH_PDF_ENGINE)" });
  }

  const pt = await toolVersion("pdftotext", ["-v"]);
  out.push({ name: "pdftotext", ok: !!pt, detail: pt ?? "not installed (poppler-utils)" });

  // OCR is the only rung that can read a scan, and it needs TWO binaries. Which
  // one is missing is the whole answer here — "OCR unavailable" would send you
  // looking in the wrong place, and copyable-pdf's own remedy for a missing
  // tesseract is an interactive `brew install` this never triggers.
  if (rungs.includes("ocr")) {
    const { copyablePdf, tesseract } = await ocrTools();
    out.push({
      name: "ocr",
      ok: copyablePdf && tesseract,
      detail:
        copyablePdf && tesseract
          ? `copyable-pdf + tesseract, ${ocrBudgetLeft()} document(s) per run (ULTRASEARCH_OCR_MAX)`
          : !copyablePdf && !tesseract
            ? "not installed — `brew install maxgfr/tap/copyable-pdf tesseract` (scanned PDFs stay unreadable)"
            : copyablePdf
              ? "copyable-pdf is installed but tesseract is not — `brew install tesseract`"
              : "tesseract is installed but copyable-pdf is not — `brew install maxgfr/tap/copyable-pdf`",
    });
  } else {
    out.push({ name: "ocr", ok: false, detail: "skipped (ULTRASEARCH_PDF_ENGINE)" });
  }

  out.push({ name: "pdf ladder", ok: true, detail: rungs.join(" → ") });

  // The office-document converter. It needs Node 20+, one version above this
  // package's own floor, so "unavailable" here is a normal outcome on a Node 18
  // host rather than a misconfiguration — say so instead of implying a fix.
  const docRungs = enabledDocExtractors();
  if (docRungs.includes("anydoc")) {
    const v = await toolVersion("npx", ["-y", "--prefer-offline", ANYDOC_SPEC, "--version"]);
    out.push({
      name: "anydoc",
      ok: !!v,
      detail: v ? `${v} (via npx)` : "unavailable — needs npm, Node 20+, and a prebuilt binary for this platform",
    });
  } else {
    out.push({ name: "anydoc", ok: false, detail: "skipped (ULTRASEARCH_NO_NPX / ULTRASEARCH_DOC_ENGINE)" });
  }
  out.push({
    name: "doc ladder",
    ok: docRungs.length > 0,
    // An empty ladder is not a broken one, but it does mean every .docx/.pptx a
    // run meets will be refused — worth saying plainly rather than printing "".
    detail: docRungs.length ? docRungs.join(" → ") : "disabled — office documents will be refused, not read",
  });
  return out;
}

/**
 * One line summarising what the optional helpers did during a run, for the
 * dossier notes. Says "not used" explicitly rather than staying quiet — a helper
 * that contributed nothing is exactly the case worth surfacing.
 */
export function describeServices(s: ManifestServices): string {
  const parts: string[] = [];
  parts.push(
    s.searxng.requested ? `searxng ${s.searxng.sources ? `✓ ${s.searxng.sources} result(s)` : "✗ no results"}` : "searxng not in this mode's backends",
  );
  parts.push(s.firecrawl.pages ? `firecrawl ✓ ${s.firecrawl.pages} page(s)` : "firecrawl ✗ not used");
  const pdf = Object.entries(s.pdf);
  if (pdf.length) parts.push(`pdf ${pdf.map(([k, n]) => `${k} ✓ ${n}`).join(", ")}`);
  const doc = Object.entries(s.doc ?? {});
  if (doc.length) parts.push(`doc ${doc.map(([k, n]) => `${k} ✓ ${n}`).join(", ")}`);
  return parts.join(" · ") + ". Run `ultrasearch doctor` to see what is available.";
}

/** Render `probeServices` output as the lines `doctor` prints. */
export function formatServices(rows: ServiceStatus[]): string {
  const w = Math.max(...rows.map((r) => r.name.length));
  return rows.map((r) => `  ${r.ok ? "✓" : "✗"} ${r.name.padEnd(w)}  ${r.detail}`).join("\n");
}

/**
 * The WebSearch lane, as `doctor` reports it.
 *
 * It cannot be probed: the tool lives in the caller's harness, not in this
 * process. What CAN be checked is whether a given run actually used one — and
 * that is the failure worth catching, because it is invisible everywhere else.
 * A dossier built without a lane looks exactly like one built with a bad lane.
 */
export function describeWebSearchLane(manifest?: { webSearch?: { supplied: number; rejected: number; kept: number }; searchProfile?: string }): ServiceStatus {
  if (!manifest) {
    return {
      name: "websearch",
      ok: true,
      detail: "the PRIMARY engine — supplied by you, not probeable here. Run `queries`, then `gather --web-results <f.json>`.",
    };
  }
  const ws = manifest.webSearch;
  if (!ws?.supplied) {
    return {
      name: "websearch",
      ok: false,
      detail: "this run had NO lane — discovery fell back to the best-effort keyless engines. Top it up: `ingest --run <dir> --web-results <f.json>`.",
    };
  }
  return {
    name: "websearch",
    ok: true,
    detail: `${ws.supplied} hit(s) supplied → ${ws.kept} kept${ws.rejected ? ` (${ws.rejected} rejected)` : ""}${manifest.searchProfile ? `, --search ${manifest.searchProfile}` : ""}`,
  };
}

// --- container lifecycle ---------------------------------------------------
//
// Driven by the engine, which embeds the compose file. `ultrasearch searxng up`
// therefore works from any install — `npx skills add`, a curled bundle, a
// Homebrew cellar — and not only from a checkout with docker-compose.yml beside
// the source, which is where the previous version gave up with a "not found".
//
// `status` deliberately does NOT go through it: `docker compose ps` answers
// whether a container is running, and what a run cares about is whether the
// endpoint ANSWERS. probeServices above is the honest question.
export { stackControl } from "./engine.js";
