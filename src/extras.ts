import { join } from "node:path";
import type { Manifest, ModeExtra, Source } from "./types.js";
import { writeArtifact } from "./no-write.js";
import { toBibtex } from "./bibtex.js";

// A mode's extra outputs, as ONE table.
//
// An extra used to be a function each producer remembered to call: `gather` and
// `merge` both ended with `writeBibtex(...)`, and `ingest` / `relink` — which
// rewrite the same dossier — did not, so a source added after the run never
// reached refs.bib. Routing every extra through `writeDossierIndex`, the one
// place all four producers already pass through, makes "the index and its
// extras agree" a property of the code instead of a habit of its callers.
//
// Adding an extra is one entry here. `Record<ModeExtra, …>` makes the compiler
// refuse a ModeExtra that has no entry.

export interface ExtraContext {
  dir: string;
  sources: Source[];
  manifest: Manifest;
}

export interface ExtraSpec {
  /** Artifacts this extra writes, relative to the dossier — what `--stdout` streams after the extracts. */
  files: readonly string[];
  /**
   * Called once per source while its FULL text is still in hand (the on-disk
   * extract is depth-capped). Whatever it needs later goes on the returned
   * meta, so merge and relink can re-aggregate without reading text back.
   * Must be idempotent: merge re-annotates sources that already carry it.
   */
  annotate?: (text: string, source: Source, manifest: Manifest) => Source["meta"];
  /** Write the artifact(s). Returns the lines to inject into DOSSIER.md — empty for none. */
  write?: (ctx: ExtraContext) => string[];
}

export const EXTRAS: Record<ModeExtra, ExtraSpec> = {
  // research: a BibTeX file built from the scholarly sources' metadata.
  bibtex: {
    files: ["refs.bib"],
    write: ({ dir, sources }) => {
      writeArtifact(join(dir, "refs.bib"), toBibtex(sources));
      return [];
    },
  },
  // learn: the model writes these into REPORT.md itself; the engine has nothing to produce.
  glossary: { files: [] },
  exercises: { files: [] },
};

function active(manifest: Manifest): ExtraSpec[] {
  // A manifest from an older version may name an extra this one no longer has.
  return (manifest.extras ?? []).map((e) => EXTRAS[e]).filter((s): s is ExtraSpec => s !== undefined);
}

/** Run every active extra's annotator over one source. Returns the source unchanged when none applies. */
export function annotateExtras(text: string, source: Source, manifest: Manifest): Source {
  let out = source;
  for (const spec of active(manifest)) {
    if (!spec.annotate) continue;
    const meta = spec.annotate(text, out, manifest);
    if (meta !== out.meta) out = { ...out, meta };
  }
  return out;
}

/** Write every active extra's artifacts. Returns the DOSSIER.md blocks, one per extra that has one. */
export function writeExtras(dir: string, sources: Source[], manifest: Manifest): string[][] {
  const blocks: string[][] = [];
  for (const spec of active(manifest)) {
    const lines = spec.write?.({ dir, sources, manifest }) ?? [];
    if (lines.length) blocks.push(lines);
  }
  return blocks;
}

/** Every artifact any extra can write, in registry order — what `--stdout` streams. */
export function extraFiles(): string[] {
  return [...new Set(Object.values(EXTRAS).flatMap((s) => s.files))];
}
