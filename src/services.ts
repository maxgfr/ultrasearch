import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { runWithInput } from "./backends/pdf/exec.js";
import { firecrawlBase, probeFirecrawl } from "./backends/firecrawl.js";
import { resolveSearxngBase, probeSearxng } from "./backends/searxng.js";
import { enabledExtractors } from "./backends/pdf.js";
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

  const sxBase = resolveSearxngBase({ options: { searxng: opts.searxng } });
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
    const up = await probeFirecrawl(fcBase);
    out.push({
      name: "firecrawl",
      ok: up,
      detail: up ? `answering at ${fcBase}` : `not running at ${fcBase} — \`ultrasearch firecrawl up\``,
    });
  }

  const rungs = enabledExtractors();
  if (rungs.includes("pdf-inspector")) {
    const v = await toolVersion("npx", ["-y", "--prefer-offline", "@firecrawl/pdf-inspector", "--version"]);
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

  out.push({ name: "pdf ladder", ok: true, detail: rungs.join(" → ") });
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
  return parts.join(" · ") + ". Run `ultrasearch doctor` to see what is available.";
}

/** Render `probeServices` output as the lines `doctor` prints. */
export function formatServices(rows: ServiceStatus[]): string {
  const w = Math.max(...rows.map((r) => r.name.length));
  return rows.map((r) => `  ${r.ok ? "✓" : "✗"} ${r.name.padEnd(w)}  ${r.detail}`).join("\n");
}

// --- container lifecycle ---------------------------------------------------

// docker-compose.yml sits at the package root, two levels up from the bundle
// (scripts/ultrasearch.mjs). A `npx skills add` install copies only
// skills/<name>/, so there is no compose file there — hence the explicit
// "not found" path rather than an obscure docker error.
export function composeFile(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const root of [join(here, ".."), join(here, "..", "..")]) {
    const p = join(root, "docker-compose.yml");
    if (existsSync(p)) return p;
  }
  return undefined;
}

export const SERVICE_PROFILES: Record<string, string[]> = {
  searxng: ["search"],
  firecrawl: ["search", "extract"], // Firecrawl delegates its keyless /search to SearXNG
};

/** Run `docker compose` for a service's profiles. Resolves with its exit code. */
export function compose(service: string, action: "up" | "down"): Promise<number> {
  const file = composeFile();
  if (!file) {
    process.stderr.write(
      `ultrasearch: docker-compose.yml not found next to the engine.\n` +
        `             This copy of the skill ships the engine alone. Clone the repo\n` +
        `             (or \`npm i -g ultrasearch\`) to manage the containers, or run:\n` +
        `             docker compose --profile ${SERVICE_PROFILES[service]!.join(" --profile ")} ${action}${action === "up" ? " -d --wait" : ""}\n`,
    );
    return Promise.resolve(1);
  }
  const profiles = SERVICE_PROFILES[service]!.flatMap((p) => ["--profile", p]);
  const args = ["compose", "-f", file, ...profiles, action, ...(action === "up" ? ["-d", "--wait"] : [])];
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.on("error", (e: NodeJS.ErrnoException) => {
      process.stderr.write(e.code === "ENOENT" ? "ultrasearch: docker not found on PATH.\n" : `ultrasearch: ${e.message}\n`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
