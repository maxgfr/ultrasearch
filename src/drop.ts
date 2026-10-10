import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Source } from "./types.js";
import { readDossier, readSourceText, writeDossierIndex } from "./dossier.js";
import { getMode } from "./modes/registry.js";
import { citedSourceIds } from "./claims.js";
import { isNoWrite } from "./no-write.js";
import { wallPattern } from "./walls.js";

// Removing sources from a dossier — the one edit no other command could make.
//
// Without it, 38 cookie walls banked into `sources.json` could only be cleared
// by rebuilding the dossier from scratch, three times over. The rules:
//
//   • Ids are STABLE: the gaps a drop leaves are kept, never renumbered. Every
//     `[S#]` already written keeps meaning what it meant.
//   • A dropped id is NEVER handed out again. It is recorded in
//     `manifest.droppedIds`, which `maxSourceId` counts as taken — so a report
//     still citing it fails `check` as dangling instead of silently resolving to
//     the next page ingested.
//   • The index is rewritten through `writeDossierIndex`, like every other path
//     that edits a dossier, so refs.bib / codes.json / DOSSIER.md follow.

/** Which sources a `drop --where` selects. */
export const DROP_WHERE = ["wall", "snippet", "offtopic"] as const;
export type DropWhere = (typeof DROP_WHERE)[number];

export interface DroppedSource {
  id: string;
  url: string;
  title: string;
  reason: string;
}

export interface DropResult {
  run: string;
  dryRun: boolean;
  /** What was (or, under dryRun, would be) removed. */
  dropped: DroppedSource[];
  /** Ids asked for by `ids` that are not in the dossier. */
  missing: string[];
  /** Report tiers that cite a dropped id — `check` will call those citations dangling. */
  citedBy: { file: string; ids: string[] }[];
  /** Sources left in the dossier. */
  remaining: number;
}

const TIERS = ["REPORT.md", "SUMMARY.md", "glossary.md"];

function safeText(dir: string, s: Source): string {
  try {
    return readSourceText(dir, s);
  } catch {
    return "";
  }
}

/** Why `where` selects this source, or undefined when it does not. */
function selects(dir: string, s: Source, where: DropWhere): string | undefined {
  if (where === "offtopic") return s.offTopic ? "probably off-topic" : undefined;
  if (where === "snippet") return s.fullText === false ? (s.wall ? "a wall (snippet only)" : "snippet only") : undefined;
  if (s.wall) return "a wall";
  // A dossier built before the flag existed: the extract's own wording.
  const worded = wallPattern(safeText(dir, s));
  return worded ? `a ${worded}` : undefined;
}

/**
 * Remove sources from a dossier, by id or by kind. Nothing is written when
 * nothing matches, or under `dryRun`.
 */
export function dropSources(dir: string, sel: { ids?: string[]; where?: DropWhere; dryRun?: boolean }): DropResult {
  if (!sel.ids?.length && !sel.where) throw new Error("drop needs --id <S#,…> or --where wall|snippet|offtopic");
  const { sources, manifest } = readDossier(dir);
  // Resolved before anything is removed: an unknown mode must throw while the
  // dossier is still whole.
  const template = getMode(manifest.mode).template;

  const byId = new Map(sources.map((s) => [s.id, s] as const));
  const reasons = new Map<string, string>();
  const missing: string[] = [];
  for (const raw of sel.ids ?? []) {
    const id = raw.trim().toUpperCase();
    if (!id) continue;
    if (byId.has(id)) reasons.set(id, "asked for by id");
    else if (!missing.includes(id)) missing.push(id);
  }
  if (sel.where) {
    for (const s of sources) {
      const why = selects(dir, s, sel.where);
      if (why && !reasons.has(s.id)) reasons.set(s.id, why);
    }
  }

  const dropped: DroppedSource[] = sources.filter((s) => reasons.has(s.id)).map((s) => ({ id: s.id, url: s.url, title: s.title, reason: reasons.get(s.id)! }));
  const ids = new Set(dropped.map((d) => d.id));

  // Which tiers already cite what is about to go: the drop is not refused for it
  // (the claim may be the very thing being cleaned up), but it is said out loud.
  const citedBy: DropResult["citedBy"] = [];
  for (const file of TIERS) {
    const p = join(dir, file);
    if (!existsSync(p)) continue;
    const hit = [...citedSourceIds(readFileSync(p, "utf8"))].filter((id) => ids.has(id));
    if (hit.length) citedBy.push({ file, ids: hit });
  }

  const remaining = sources.filter((s) => !ids.has(s.id));
  const dryRun = sel.dryRun === true;
  if (dropped.length && !dryRun) {
    // The extracts first: an index that no longer names a file is harmless, a
    // file the index still names but that is gone is not. Under no-write the
    // command is refused before it gets here; the guard is belt and braces.
    if (!isNoWrite()) {
      for (const d of dropped) {
        const s = byId.get(d.id)!;
        rmSync(join(dir, s.extract), { force: true });
      }
    }
    const droppedIds = [...new Set([...(manifest.droppedIds ?? []), ...ids])].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    writeDossierIndex(dir, remaining, { ...manifest, sourceCount: remaining.length, droppedIds }, template);
  }
  return { run: dir, dryRun, dropped, missing, citedBy, remaining: dryRun ? sources.length : remaining.length };
}

/** The CLI's account of a drop, one line per source and per warning. */
export function formatDropReport(r: DropResult): string {
  const lines: string[] = [];
  const verb = r.dryRun ? "would drop" : "dropped";
  if (!r.dropped.length) lines.push(`ultrasearch drop: nothing matched — the dossier is unchanged (${r.remaining} source(s)).`);
  else lines.push(`ultrasearch drop: ${verb} ${r.dropped.length} source(s) → ${r.remaining} left in ${r.run}`);
  for (const d of r.dropped) lines.push(`  ${d.id}  ${d.reason}  ${d.url}`);
  if (r.missing.length) lines.push(`  ⚠ not in this dossier: ${r.missing.join(", ")}`);
  for (const c of r.citedBy) {
    lines.push(`  ⚠ ${c.file} cites ${c.ids.join(", ")} — \`check\` will fail them as dangling: rewrite those claims onto another source.`);
  }
  if (r.dropped.length && !r.dryRun) lines.push("  ids are never reused: the next source ingested takes a fresh one.");
  return lines.join("\n");
}
