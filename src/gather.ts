import { join } from "node:path";
import { tmpdir } from "node:os";
import { VERSION } from "./types.js";
import type { BackendKind, GatherOptions, Manifest, ModeProfile, RawSource, RunContext, Source } from "./types.js";
import { getMode } from "./modes/registry.js";
import { runBackends } from "./backends/registry.js";
import { fetchAndExtract, bestExcerpt } from "./backends/fetch.js";
import { writeDossier } from "./dossier.js";
import { toBibtex } from "./bibtex.js";
import { canonicalizeUrl, domainOf, rrf, runId, slugify } from "./util.js";
import { writeFileSync } from "node:fs";

export interface GatherResult {
  dir: string;
  sources: Source[];
  manifest: Manifest;
}

const ENRICH_NUDGE =
  "agent: enrich thin areas with your own WebSearch, then ingest each good URL via " +
  "`ultrasearch fetch --url <u> --out <dir>` before writing the report.";

// Default dossier directory under the OS temp dir, keyed by mode + question.
export function defaultRunDir(mode: string, question: string, d?: Date): string {
  return join(tmpdir(), "ultrasearch", `${mode}-${slugify(question)}`, runId(d));
}

// Which backends a run uses: an explicit --backends override, else the mode's
// profile (plus its deep-only backends at --depth deep).
export function resolveBackends(options: GatherOptions, mode: ModeProfile): BackendKind[] {
  if (options.backends && options.backends.length) return [...new Set(options.backends)];
  const base = options.depth === "deep" ? [...mode.backends, ...mode.deepOnly] : [...mode.backends];
  return [...new Set(base)];
}

// Merge each backend's ranked list into one ranking by Reciprocal Rank Fusion
// over canonical URL, deduping so the same page can't appear twice. When the
// same URL comes from two backends, prefer the copy that already carries text
// and merge their metadata.
function fuse(lists: RawSource[][]): RawSource[] {
  const fused = rrf(lists, (it) => canonicalizeUrl(it.url));
  const best = new Map<string, RawSource>();
  for (const list of lists) {
    for (const it of list) {
      const key = canonicalizeUrl(it.url);
      const prev = best.get(key);
      if (!prev) {
        best.set(key, { ...it });
      } else if (!prev.text && it.text) {
        best.set(key, { ...it, meta: { ...prev.meta, ...it.meta } });
      } else if (it.meta) {
        prev.meta = { ...it.meta, ...prev.meta };
      }
    }
  }
  const merged = [...best.values()];
  for (const it of merged) it.score = fused.get(canonicalizeUrl(it.url)) ?? 0;
  merged.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return merged;
}

// Full `gather`: fan out backends, fuse + dedupe + filter + cap, fetch full
// text for any source that lacks it, then write the dossier. The model writes
// the tiered reports afterward.
export async function runGather(options: GatherOptions): Promise<GatherResult> {
  const t0 = Date.now();
  const mode = getMode(options.mode);
  const backends = resolveBackends(options, mode);
  const ctx: RunContext = { question: options.question, mode, options };

  const results = await runBackends(backends, ctx);

  const lists = results.map((r) => [...r.items].sort((a, b) => b.score - a.score));
  let merged = fuse(lists);

  // --exclude-domains: drop unwanted hosts (suffix match).
  if (options.excludeDomains.length) {
    merged = merged.filter((it) => {
      const d = domainOf(it.url);
      return !options.excludeDomains.some((ex) => d === ex || d.endsWith("." + ex));
    });
  }

  const droppedDup = lists.reduce((n, l) => n + l.length, 0) - merged.length;
  merged = merged.slice(0, options.maxSources);

  // Hydrate: discovery backends (searxng/ddg) return URLs without text — fetch
  // and clean each kept page. Done concurrently; a failed fetch keeps the
  // snippet-only source and records a note rather than dropping silently.
  const hydrateNotes: string[] = [];
  await Promise.all(
    merged.map(async (it) => {
      if (it.text && it.text.trim()) return;
      const { text, title, note } = await fetchAndExtract(it.url);
      if (note) hydrateNotes.push(note);
      if (text && text.trim()) {
        it.text = text;
        if (!it.snippet) it.snippet = bestExcerpt(text, options.question);
        if ((!it.title || it.title === it.url) && title) it.title = title;
      } else {
        it.text = it.snippet || "";
      }
    }),
  );
  // Drop any source that ended up with no usable content at all.
  merged = merged.filter((it) => (it.text && it.text.trim()) || it.snippet.trim());

  const backendsUsed = results.filter((r) => r.items.length > 0).map((r) => r.backend);
  const timings: Record<string, number> = {};
  for (const r of results) if (r.ms !== undefined) timings[r.backend] = r.ms;
  timings.total = Date.now() - t0;

  const notes = [
    ...results.flatMap((r) => r.notes),
    ...hydrateNotes,
    ...(droppedDup > 0 ? [`Dropped ${droppedDup} duplicate result(s) across backends.`] : []),
    ENRICH_NUDGE,
  ];

  const manifest: Manifest = {
    version: VERSION,
    question: options.question,
    mode: options.mode,
    depth: options.depth,
    lang: options.lang,
    backends,
    backendsUsed,
    sourceCount: merged.length,
    maxSources: options.maxSources,
    builtAt: new Date().toISOString(),
    slug: `${options.mode}-${slugify(options.question)}`,
    tiers: ["SUMMARY.md", "REPORT.md", "FULL.md"],
    extras: mode.extras,
    notes,
    timings,
  };

  const dir = options.out ?? defaultRunDir(options.mode, options.question);
  const { sources } = writeDossier(dir, merged, manifest, mode.template);
  // Research mode ships a BibTeX file built from the scholarly sources.
  if (mode.extras.includes("bibtex")) {
    writeFileSync(join(dir, "refs.bib"), toBibtex(sources));
  }
  return { dir, sources, manifest: { ...manifest, sourceCount: sources.length } };
}
