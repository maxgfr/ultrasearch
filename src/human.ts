// The human's half of the browser rung, for a whole dossier: `ultrasearch human`.
//
// A read that meets a CAPTCHA, an anti-bot check or a sign-in wall is never
// solved for anyone. Gather banks such a source as ⛔ (a wall by its wording) or
// ⚠ snippet only, with the engine's note naming the challenge it met. This finds
// those sources and hands each page in turn to the human through the engine's
// handoff (`human` on the read): the page comes up in the dedicated browser's
// window, the human gets past the wall, and the text that comes back repairs the
// source in place — through addSources, the very path `fetch --url` takes on a ⛔
// source — so every [S#] a report cites keeps pointing at the same document.

import { readDossier } from "./dossier.js";
import { addSources } from "./enrich.js";
import type { Manifest, Source } from "./types.js";

export interface HumanCandidate {
  id: string;
  url: string;
  /** What stands in front of it, in a few words: "⛔ wall", "snippet only — cloudflare challenge". */
  why: string;
}

export type HumanVerdict = "repaired" | "still walled" | "timed out" | "skipped";

export interface HumanResult extends HumanCandidate {
  outcome: HumanVerdict;
  note?: string;
}

// What a read note says when a person could have got past what stopped it: the
// engine's challenge note ("cloudflare challenge — open it with …"), a CAPTCHA,
// an anti-bot interstitial, a sign-in wall. A 404 or a timeout is nobody's to fix.
const HUMAN_NOTE = /\b(?:[a-z]+ )?challenge\b|\b(?:re)?captcha\b|\banti-bot\b|\bbot check\b|\b(?:login|log-in|sign-in|signin) wall\b/i;

/** True when `note` names `url` itself — not a longer URL it is the start of. */
function mentions(note: string, url: string): boolean {
  for (let i = note.indexOf(url); i >= 0; i = note.indexOf(url, i + 1)) {
    const next = note.slice(i + url.length, i + url.length + 2);
    if (next === "" || /^[\s`'"),;]/.test(next) || /^\.(?:\s|$)/.test(next)) return true;
  }
  return false;
}

/**
 * The sources a human could unblock: every ⛔ wall, and every snippet-only
 * source whose read the run's notes say was stopped by a challenge, an anti-bot
 * check or a sign-in wall. In dossier order.
 */
export function humanCandidates(sources: Source[], manifest: Pick<Manifest, "notes">): HumanCandidate[] {
  const out: HumanCandidate[] = [];
  for (const s of sources) {
    if (s.wall) {
      out.push({ id: s.id, url: s.url, why: "⛔ wall" });
      continue;
    }
    if (s.fullText !== false) continue;
    const said = (manifest.notes ?? []).find((n) => mentions(n, s.url) && HUMAN_NOTE.test(n));
    if (said) out.push({ id: s.id, url: s.url, why: `snippet only — ${HUMAN_NOTE.exec(said)?.[0] ?? "walled"}` });
  }
  return out;
}

/**
 * The one line gather, ingest and fetch end with when a dossier holds pages a
 * human could unblock; undefined when it holds none (or cannot be read).
 */
export function humanHint(dir: string): string | undefined {
  try {
    const { sources, manifest } = readDossier(dir);
    const n = humanCandidates(sources, manifest).length;
    return n ? `${n} page(s) need a human: ultrasearch human --run ${dir}` : undefined;
  } catch {
    return undefined;
  }
}

export interface HumanSelection {
  /** What will be handed over, in dossier order. */
  chosen: HumanCandidate[];
  /** Asked for by --id, and left alone: the reason is the note. */
  skipped: HumanResult[];
  /** Asked for by --id, and not in the dossier. */
  missing: string[];
}

/**
 * What `human` works on: every candidate, or — with `ids` — those sources. An id
 * the run did not flag is still taken when its source is weak (⛔ or snippet
 * only): you know why it is, the run may not. A source that holds its text is
 * left alone.
 */
export function selectForHuman(dir: string, ids?: string[]): HumanSelection {
  const { sources, manifest } = readDossier(dir);
  const flagged = humanCandidates(sources, manifest);
  if (!ids?.length) return { chosen: flagged, skipped: [], missing: [] };
  const want = new Set(ids.map((id) => id.trim().toUpperCase()));
  const chosen: HumanCandidate[] = [];
  const skipped: HumanResult[] = [];
  for (const s of sources) {
    if (!want.has(s.id)) continue;
    const c = flagged.find((f) => f.id === s.id);
    if (c) chosen.push(c);
    else if (s.fullText === false) chosen.push({ id: s.id, url: s.url, why: "snippet only" });
    else skipped.push({ id: s.id, url: s.url, why: "holds its text", outcome: "skipped", note: `${s.id} already holds its page's text` });
  }
  const known = new Set(sources.map((s) => s.id));
  return { chosen, skipped, missing: [...want].filter((id) => !known.has(id)) };
}

export interface RunHumanOptions {
  /** How long the human has for each page, in ms (the engine's 5 minutes by default). */
  timeoutMs?: number;
  firecrawl?: string;
  /** Why nobody can be shown a window here; every page is then skipped, and nobody is waited for. */
  noWindow?: string;
  /** Told before each page is handed over. */
  onStart?: (c: HumanCandidate) => void;
  /** Told as each page's outcome is known. */
  onResult?: (r: HumanResult) => void;
}

/**
 * Hand each chosen page to the human, one at a time, and repair its source in
 * place when the text comes back. Sequential on purpose: there is one human,
 * one window, and the repair rewrites the dossier's index.
 */
export async function runHuman(dir: string, chosen: HumanCandidate[], opts: RunHumanOptions = {}): Promise<HumanResult[]> {
  const results: HumanResult[] = [];
  const done = (r: HumanResult) => {
    results.push(r);
    opts.onResult?.(r);
  };
  if (!chosen.length) return results;
  const { manifest } = readDossier(dir);
  for (const c of chosen) {
    if (opts.noWindow) {
      done({ ...c, outcome: "skipped", note: opts.noWindow });
      continue;
    }
    opts.onStart?.(c);
    // The browser renders it first — the human is in the browser — and the cache
    // is not read: a cached copy is the wall this source already holds.
    const got = await addSources(dir, [c.url], {
      question: manifest.question,
      cache: false,
      browser: "always",
      human: opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {},
      ...(opts.firecrawl ? { firecrawl: opts.firecrawl } : {}),
    });
    const r = got.results[0];
    const outcome: HumanVerdict = r?.repaired ? "repaired" : r?.handoff === "timeout" ? "timed out" : r?.handoff === "no-window" ? "skipped" : "still walled";
    done({ ...c, outcome, ...(r?.note ? { note: r.note } : {}) });
  }
  return results;
}
