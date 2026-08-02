import type { Manifest, Source } from "./types.js";
import { readDossier, readSourceText, writeSourceExtract, writeDossierIndex } from "./dossier.js";
import { getMode } from "./modes/registry.js";
import { looksLikeJunkExtraction } from "./backends/fetch.js";
import { deriveCitableUrl, isCitableUrl } from "./citable.js";
import { canonicalizeUrl, domainOf, titleFromText, trustScore } from "./util.js";

// The repair pass, in three tiers of decreasing certainty.
//
//   1. The engine repairs what the evidence already proves. A source whose url
//      is a machine endpoint usually carries its own identity in the text it
//      returned — a DOI, an arXiv id, a PMID. That is a fact on disk, not a
//      guess, so `relink` rewrites it with no network and no help.
//   2. What the text does NOT prove becomes a worklist: the url, the reason, and
//      what would settle it. Finding the right page takes a search — the agent's
//      job, not a table's.
//   3. `relink --id S# --url <page>` folds the agent's answer back in.
//
// Same division of labour as `verify`: the engine decides what it can prove,
// refuses the rest out loud, and stays the only writer.

export interface RelinkIssue {
  id: string;
  url: string;
  reason: "not-citable" | "duplicate" | "wall";
  detail: string;
  /** The url the source's own text names, when it names one. Applied automatically. */
  derived?: string;
  /** What to search WITH when the engine can't derive it: the source's title and the head of its text. */
  evidence?: { title: string; excerpt: string };
  fix: string;
}

export interface RelinkResult {
  id: string;
  relinked: boolean;
  from?: string;
  to?: string;
  note?: string;
}

/** Everything wrong with a dossier's sources that the citation graph can't see. */
export function listIssues(dir: string): RelinkIssue[] {
  const { sources } = readDossier(dir);
  const issues: RelinkIssue[] = [];
  for (const s of sources) {
    const text = safeText(dir, s);
    if (!isCitableUrl(s.url)) {
      const derived = text ? deriveCitableUrl(text) : undefined;
      // The derived page can already be in the dossier — the same document
      // gathered once by a backend and pinned once through an endpoint. That is
      // a DUPLICATE, and merging two ids would silently orphan the claims citing
      // this one, so it goes to the agent with the twin named.
      const twin = derived ? sources.find((o) => o.id !== s.id && o.canonicalUrl === canonicalizeUrl(derived)) : undefined;
      issues.push({
        id: s.id,
        url: s.url,
        reason: twin ? "duplicate" : "not-citable",
        // No derivation means the payload named nothing — so hand over what a
        // SEARCH can start from instead of a dead end. Reconstructing the page
        // from a title and an opening paragraph is the agent's job, not a
        // regex's.
        ...(derived ? {} : { evidence: { title: s.title === s.url ? titleFromText(text) : s.title, excerpt: text.replace(/\s+/g, " ").trim().slice(0, 400) } }),
        detail: twin
          ? `the url is a machine endpoint, and the document it names is already in the dossier as ${twin.id}`
          : "the url is a machine endpoint — a reader who clicks it gets a payload, not the document",
        ...(derived ? { derived } : {}),
        fix: twin
          ? `cite ${twin.id} instead and drop ${s.id}'s citations, or relink ${s.id} to a different page`
          : derived
            ? `its own text names ${derived} — \`relink --run <dir>\` applies that for you`
            : `its text names no document — search for it with the evidence below, then: relink --run <dir> --id ${s.id} --url "<page>"`,
      });
      continue;
    }
    const wall = text ? looksLikeJunkExtraction(text) : undefined;
    if (wall) {
      issues.push({
        id: s.id,
        url: s.url,
        reason: "wall",
        detail: `the extract is a ${wall}, not the document — the host was throttling when it was fetched`,
        fix: `the text is missing, not just the link: re-run \`fetch --url "${s.url}"\` into a dossier, or drop the claims resting on it`,
      });
    }
  }
  return issues;
}

/**
 * Repair every source whose own text proves where it lives, and report what is
 * left. No network: this reads the extracts already on disk.
 */
export function autoRelink(dir: string): { repaired: RelinkResult[]; remaining: RelinkIssue[] } {
  const repaired: RelinkResult[] = [];
  // Re-listed each round: a repair rewrites sources.json, and it can turn a
  // LATER source into a duplicate of the one just fixed, so the next candidate
  // has to be read back rather than held from a stale snapshot. `tried` makes
  // the loop terminate: a candidate the writer refuses is never re-offered.
  const tried = new Set<string>();
  for (;;) {
    const next = listIssues(dir).find((i) => i.reason === "not-citable" && i.derived && !tried.has(i.id));
    if (!next) break;
    tried.add(next.id);
    const r = relink(dir, next.id, next.derived!);
    if (r.relinked) repaired.push(r); // a refusal just stays in the worklist
  }
  return { repaired, remaining: listIssues(dir) };
}

function safeText(dir: string, s: Source): string {
  try {
    return readSourceText(dir, s);
  } catch {
    return ""; // an unreadable extract is UNKNOWN — never a verdict
  }
}

/**
 * Point a source at the page it should have cited all along. The extract is NOT
 * re-fetched: relink repairs the CITATION, and the text already on disk is
 * whatever the endpoint legitimately returned. (A source whose text is a wall
 * needs a re-`fetch`, which is why `listIssues` says so for that class.)
 */
export function relink(dir: string, id: string, url: string, opts: { title?: string } = {}): RelinkResult {
  const { sources, manifest } = readDossier(dir);
  const idx = sources.findIndex((s) => s.id === id);
  if (idx < 0) return { id, relinked: false, note: `${id} is not in this dossier` };
  const target = sources[idx]!;

  const next = url.trim();
  if (!isCitableUrl(next)) {
    return { id, relinked: false, note: `${next} is not a citable page url — a citation must open in a browser` };
  }
  const canon = canonicalizeUrl(next);
  if (canon === target.canonicalUrl) return { id, relinked: false, note: `${id} already points at ${next}` };
  const clash = sources.find((s) => s.id !== id && s.canonicalUrl === canon);
  if (clash) return { id, relinked: false, note: `${clash.id} already cites ${next} — merge the claims onto it instead of duplicating the source` };

  const from = target.url;
  const text = safeText(dir, target);
  // A url standing in as a title is part of the same symptom — swapping in the
  // NEW url would just relabel it. The document's own text is the better name.
  const titled = target.title && target.title !== from ? target.title : titleFromText(text) || next;
  const relinked: Source = {
    ...target,
    url: next,
    canonicalUrl: canon,
    domain: domainOf(next),
    trust: trustScore(next, target.backend),
    title: opts.title || titled,
    // Where the text came from stays on the record: the claim is grounded in
    // that payload, and a reader auditing the source deserves to know.
    meta: { ...target.meta, textVia: target.meta?.textVia ?? from },
  };

  const nextSources = [...sources];
  nextSources[idx] = relinked;
  // The extract's header carries the url and title, so it has to be rewritten.
  writeSourceExtract(dir, relinked, text, manifest.depth);
  writeDossierIndex(dir, nextSources, refreshed(manifest, nextSources), getMode(manifest.mode).template);
  return { id, relinked: true, from, to: next };
}

function refreshed(manifest: Manifest, sources: Source[]): Manifest {
  return { ...manifest, sourceCount: sources.length };
}
