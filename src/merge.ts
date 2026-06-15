import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest, ModeName, Provenance, RawSource, Source } from "./types.js";
import { VERSION } from "./types.js";
import { readDossier, readSourceText, writeDossier } from "./dossier.js";
import { fuse, defaultRunDir } from "./gather.js";
import { dedupeNearDuplicates, identityKey, slugify } from "./util.js";
import { getMode } from "./modes/registry.js";
import { toBibtex } from "./bibtex.js";

export interface MergeOptions {
  runs: string[]; // sub-dossier run dirs (one per sub-question fan-out)
  master?: string; // output dir (default: per mode + question)
  question?: string; // the original (umbrella) question
  mode?: ModeName;
}

export interface MergeResult {
  dir: string;
  sources: Source[];
  manifest: Manifest;
}

function toRawSource(s: Source, text: string): RawSource {
  return {
    url: s.url,
    title: s.title,
    backend: s.backend,
    score: s.score,
    snippet: s.snippet,
    text,
    lang: s.lang,
    meta: s.meta,
  };
}

// Union N sub-dossiers (one per deep-research sub-question) into a single master
// dossier. Re-fuses the combined pool by identity (DOI / arXiv / canonical URL —
// so the same work found by several sub-questions collapses), drops near-
// duplicate CONTENT (SimHash), records which sub-question(s) surfaced each source
// (provenance), then re-assigns stable S# ids by final fused rank. Deterministic
// given the same inputs — builtAt is derived from them — so the master renders
// and checks reproducibly. The agent writes the report against THESE master ids,
// never the sub-run ids (which all restart at S1 and would collide).
export function runMerge(options: MergeOptions): MergeResult {
  if (!options.runs.length) throw new Error("merge needs at least one --runs dossier");
  const dossiers = options.runs.map((dir) => ({ dir, ...readDossier(dir) }));

  // Per-sub-dossier ranked RawSource lists + a provenance index keyed by identity
  // (so a source surfaced by several sub-questions carries all of them).
  const lists: RawSource[][] = [];
  const provByKey = new Map<string, Provenance[]>();
  for (const d of dossiers) {
    const subQuestion = d.manifest.question;
    const list: RawSource[] = [];
    for (const s of d.sources) {
      const raw = toRawSource(s, readSourceText(d.dir, s));
      list.push(raw);
      const key = identityKey(raw);
      const prov = provByKey.get(key) ?? [];
      if (!prov.some((pv) => pv.runDir === d.dir && pv.subQuestion === subQuestion)) {
        prov.push({ subQuestion, runDir: d.dir });
      }
      provByKey.set(key, prov);
    }
    lists.push(list);
  }

  // Fuse across the combined pool (RRF over identity), then collapse near-dup
  // content. Both are deterministic and preserve a best-first order, which
  // writeDossier turns into S1..Sn.
  const fused = fuse(lists);
  const deduped = dedupeNearDuplicates(fused);
  const merged = deduped.items;
  for (const it of merged) {
    const prov = (provByKey.get(identityKey(it)) ?? [])
      .slice()
      .sort((a, b) => a.runDir.localeCompare(b.runDir) || a.subQuestion.localeCompare(b.subQuestion));
    it.meta = { ...it.meta, provenance: prov };
  }

  const question = options.question ?? dossiers[0]!.manifest.question;
  const modeName: ModeName = options.mode ?? dossiers[0]!.manifest.mode;
  const mode = getMode(modeName);
  // Pin the timestamp to the latest input dossier so the merge is byte-reproducible.
  const builtAt = dossiers.map((d) => d.manifest.builtAt).sort().at(-1) ?? dossiers[0]!.manifest.builtAt;
  const subQuestions = dossiers.map((d, i) => ({ id: `Q${i + 1}`, question: d.manifest.question }));

  const manifest: Manifest = {
    version: VERSION,
    question,
    mode: modeName,
    depth: "deep",
    lang: dossiers[0]!.manifest.lang ?? "en",
    backends: [...new Set(dossiers.flatMap((d) => d.manifest.backends))],
    backendsUsed: [...new Set(dossiers.flatMap((d) => d.manifest.backendsUsed))],
    sourceCount: merged.length,
    maxSources: merged.length,
    builtAt,
    slug: `${modeName}-${slugify(question)}`,
    tiers: ["SUMMARY.md", "REPORT.md", "FULL.md"],
    extras: mode.extras,
    notes: [
      `Merged ${dossiers.length} sub-dossier(s) → ${merged.length} source(s) ` +
        `(${deduped.dropped} near-duplicate(s) collapsed).`,
      "agent: write the report against THIS master dossier's [S#] ids; then verify + check --semantic.",
    ],
    timings: {},
    mergedFrom: options.runs.slice(),
    subQuestions,
  };

  const dir = options.master ?? defaultRunDir(modeName, question);
  const { sources } = writeDossier(dir, merged, manifest, mode.template);
  if (mode.extras.includes("bibtex")) {
    writeFileSync(join(dir, "refs.bib"), toBibtex(sources));
  }
  return { dir, sources, manifest: { ...manifest, sourceCount: sources.length } };
}
