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
//
// A walled page is seldom the only copy of its document: a paper behind SSRN's
// Cloudflare check is on arXiv, an article behind an anti-bot page is in PubMed
// Central, an institutional repository, Zenodo, on the author's page. So the
// recovery order is the agent's own web search for another copy first —
// `ingest --web-results` with the walled url as the hit's `citeUrl` repairs the
// source in place from it — and the person only for what is still walled. On a
// live run that search found open copies of three of four walled pages in
// seconds, while the dialog interrupted the person and a 300 s wait went on a
// page nobody solved. gather, ingest and fetch therefore end with a web-search
// worklist (webSearchWorklist): each page that needs a person, its title and
// identifiers, and the command that folds a copy in; the `human` hint follows.
//
// gather, ingest and fetch can also hand the pages a CHALLENGE stopped (a
// CAPTCHA, an anti-bot check) to the person before they end: the read that met
// one is over in seconds, so a person who saw it come up had no time to solve
// it. When the command was driven by an agent's web search (`searchFirst`: a
// gather fed --web-results, and every ingest and fetch, which are an agent's
// operations) and ULTRASEARCH_HUMAN_ASK is the default `ask`, nothing is asked
// and nothing comes forward: the pages come back skipped, for the agent to
// search first and to ask the person about afterwards (`ultrasearch human`).
// Otherwise — a gather a person runs at the CLI — the person is asked first,
// once for the whole batch, with the engine's native dialog (askHuman), since
// an agent running the command reads its stderr and the person does not, and
// nothing comes forward unless they say yes (ULTRASEARCH_HUMAN_ASK: `always`
// hands over unasked, even under searchFirst; `never` hands nothing over during
// a run). On a yes the pages come forward one at a time, the browser coming
// forward only then, each waiting ULTRASEARCH_HUMAN_TIMEOUT_MS (5 minutes by
// default; 0 never waits during a run), and a notification says when it is
// done. The first page nobody gets past ends it: nobody is at the window, and
// the rest are left for `ultrasearch human`. On "Later", or no answer, they are
// all left for it. A sign-in or consent wall is never handed over this way:
// whether to sign in is the person's call, made with `ultrasearch human`.
//
// `ultrasearch human` itself does not ask: running it is the request to hand
// the pages over, and the skill has the agent ask the person before it does.

import { readDossier, readSourceText } from "./dossier.js";
import { addSources } from "./enrich.js";
import { askHuman, canShowBrowserWindow, type HumanAnswer, type HumanAskPage, humanAskMode, notifyHumanDone } from "./engine.js";
import { identityKeys } from "./identity.js";
import type { BrowserMode, Manifest, Source } from "./types.js";
import { wallPattern } from "./walls.js";

export interface HumanCandidate {
  id: string;
  url: string;
  /** What stands in front of it, in a few words: "⛔ wall", "snippet only — cloudflare challenge". */
  why: string;
  /** The read's own words about the check, when the candidate carries them (a page fetch refused): what the question names. */
  check?: string;
}

export type HumanVerdict = "repaired" | "added" | "still walled" | "timed out" | "skipped";

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

/** At most this many pages are named in the worklist; `human --list` names them all. */
const WORKLIST_CAP = 15;

/** What names a source's document beyond its url: doi:…, pmid:…, pmcid:…, arxiv:…. */
function identifiersOf(s: Source): string[] {
  const keys = new Set(identityKeys(s.url, s.meta));
  for (const k of ["pmid", "pmcid"] as const) {
    const v = s.meta?.[k];
    if ((typeof v === "string" || typeof v === "number") && String(v).trim()) keys.add(`${k}:${String(v).trim()}`);
  }
  return [...keys];
}

export interface WorklistOptions {
  /** No dossier on disk (gather --stdout): a copy is read directly, there is nothing to ingest it into. */
  stdout?: boolean;
  /** Pages the run refused for a challenge, not in the dossier: listed by url. */
  refused?: HumanCandidate[];
}

/**
 * The web-search worklist gather, ingest and fetch end with when pages need a
 * person (humanCandidates, plus the refused pages they name): a head line, one
 * line per page — its S#, title, identifiers, what stopped it, its url — and
 * the instruction to search for another copy and fold it in with `citeUrl`,
 * the person last. Empty when no page needs one. The lines come unindented: the
 * caller prefixes them.
 */
export function webSearchWorklist(dir: string, sources: Source[], manifest: Pick<Manifest, "notes">, opts: WorklistOptions = {}): string[] {
  const candidates = humanCandidates(sources, manifest);
  const refused = (opts.refused ?? []).filter((c, i, all) => !sources.some((s) => s.url === c.url) && all.findIndex((x) => x.url === c.url) === i);
  const items: string[] = [];
  for (const c of candidates) {
    const s = sources.find((x) => x.id === c.id);
    const title = s?.title && s.title !== s.url ? `"${s.title.length > 140 ? `${s.title.slice(0, 139)}…` : s.title}"` : undefined;
    items.push([c.id, title, ...(s ? identifiersOf(s) : []), c.why, c.url].filter(Boolean).join(" · "));
  }
  for (const c of refused) items.push(`not in the dossier · ${c.why} · ${c.url}`);
  if (!items.length) return [];
  const shown = items.slice(0, WORKLIST_CAP);
  if (items.length > shown.length)
    shown.push(`… and ${items.length - shown.length} more${opts.stdout ? "" : ` (ultrasearch human --run ${dir} --list names them all)`}`);
  const where = "arXiv, PubMed Central / Europe PMC, an institutional repository, Zenodo, the author's page";
  const instruction = opts.stdout
    ? `→ web search each title (or DOI) for another copy — ${where} — and read that copy directly: ` +
      "with --stdout there is no dossier to ingest it into, so cite it by its own address."
    : `→ web search each title (or DOI) for another copy — ${where} — and fold them in: ` +
      `ultrasearch ingest --run ${dir} --web-results <copies.json>, each hit carrying "citeUrl": "<walled url>" when it is the same work ` +
      `(that repairs its S# in place). Only for what is still walled, after asking the user: ultrasearch human --run ${dir}`;
  return [`${items.length} page(s) stopped at a wall or a human check — look for another copy with your web search first:`, ...shown, instruction];
}

/** webSearchWorklist for a dossier on disk; empty when it holds no such page (or cannot be read). */
export function webSearchHint(dir: string, refused?: HumanCandidate[]): string[] {
  try {
    const { sources, manifest } = readDossier(dir);
    return webSearchWorklist(dir, sources, manifest, refused?.length ? { refused } : {});
  } catch {
    return [];
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
  /** Stop at the first page nobody got past in time: nobody is at the window, and the rest are skipped. */
  stopAfterTimeout?: boolean;
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
  let unanswered: string | undefined;
  for (const c of chosen) {
    if (opts.noWindow) {
      done({ ...c, outcome: "skipped", note: opts.noWindow });
      continue;
    }
    if (unanswered) {
      done({ ...c, outcome: "skipped", note: `nobody got past ${unanswered} in time — left for \`ultrasearch human --run ${dir}\`` });
      continue;
    }
    opts.onStart?.(c);
    // The browser renders it first — the human is in the browser — and the cache
    // is not read: a cached copy is the wall this source already holds.
    const got = await addSources(dir, [c.url], {
      question: manifest.question,
      cache: false,
      browser: "always",
      // Asked already, about the whole batch (or asked for by name): the engine's read does not ask again.
      human: { ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}), ask: false },
      ...(opts.firecrawl ? { firecrawl: opts.firecrawl } : {}),
    });
    const r = got.results[0];
    const outcome: HumanVerdict = r?.repaired
      ? "repaired"
      : r?.added
        ? "added"
        : r?.handoff === "timeout"
          ? "timed out"
          : r?.handoff === "no-window"
            ? "skipped"
            : "still walled";
    done({ ...c, ...(r?.added && r.id ? { id: r.id } : {}), outcome, ...(r?.note ? { note: r.note } : {}) });
    if (outcome === "timed out" && opts.stopAfterTimeout) unanswered = c.url;
  }
  return results;
}

// --- the handoff at the end of gather, ingest and fetch ------------------------

/** The env var that bounds every wait for a person, in ms. */
export const HUMAN_TIMEOUT_ENV = "ULTRASEARCH_HUMAN_TIMEOUT_MS";
/** The env var that says whether a run asks the person before handing pages over: ask (default), always, never. */
export const HUMAN_ASK_ENV = "ULTRASEARCH_HUMAN_ASK";
/** How long a person has per page when nothing says otherwise: as long as `human` gives them. */
export const HUMAN_TIMEOUT_DEFAULT_MS = 300_000;

/**
 * How long a run waits for a person per page, in ms: ULTRASEARCH_HUMAN_TIMEOUT_MS
 * (10 s to an hour), 5 minutes when unset or unreadable — or undefined when it
 * is 0 (or less): a run then never waits, and the pages are left for `human`.
 */
export function humanTimeoutMs(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env[HUMAN_TIMEOUT_ENV]?.trim();
  const n = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return HUMAN_TIMEOUT_DEFAULT_MS;
  if (n <= 0) return undefined;
  return Math.min(3_600_000, Math.max(10_000, Math.trunc(n)));
}

// What a person at the window can get past right now: a CAPTCHA, an anti-bot
// check. Not a sign-in wall, nor a consent wall.
const CHALLENGE = /\bchallenge\b|\b(?:re|h)?captcha\b|\banti-bot\b|\bbot check\b|\bverify(?:ing)? (?:that )?you(?:'re| are) (?:a )?human\b/i;

/** The CAPTCHA or anti-bot check `text` names, or undefined. */
export function challengeIn(text: string | undefined): string | undefined {
  return text ? CHALLENGE.exec(text)?.[0] : undefined;
}

/**
 * The candidates a challenge stopped: a snippet-only source whose read met
 * one, and a ⛔ wall whose notes or extract say it is one. In dossier order.
 */
export function challengeCandidates(dir: string, sources: Source[], manifest: Pick<Manifest, "notes">): HumanCandidate[] {
  return humanCandidates(sources, manifest).filter((c) => {
    if (challengeIn(c.why)) return true;
    if ((manifest.notes ?? []).some((n) => mentions(n, c.url) && challengeIn(n))) return true;
    const s = sources.find((x) => x.id === c.id);
    try {
      return !!s && !!challengeIn(wallPattern(readSourceText(dir, s)));
    } catch {
      return false;
    }
  });
}

export interface HandOffDuringRunOptions {
  /** The command's browser rung: `off` hands nothing over — the run was told to open nothing. */
  browser: BrowserMode;
  firecrawl?: string;
  /** Pages the run refused for a challenge, not in the dossier: handed over too, and added once read. */
  refused?: HumanCandidate[];
  /** Where the lines for the person go (stderr in the CLI). */
  tell: (line: string) => void;
  env?: Record<string, string | undefined>;
  /** Defaults to the engine's: false with no display, and in any CI run. */
  canShow?: () => boolean;
  /** The question to the person, once for the batch; the engine's native dialog (askHuman) by default. */
  ask?: (pages: HumanAskPage[]) => Promise<HumanAnswer>;
  /** The notification once a batch the person said yes to is done; the engine's (notifyHumanDone) by default. */
  notify?: (cleared: number, total: number) => Promise<boolean>;
  /**
   * The command was driven by an agent's web search (a gather fed --web-results,
   * every ingest and fetch): under ULTRASEARCH_HUMAN_ASK=ask nothing is asked or
   * opened, and every page comes back skipped — the agent looks for another copy
   * first, and asks the person afterwards. `always` still hands them over.
   */
  searchFirst?: boolean;
}

/**
 * Hand the pages a challenge stopped to the person at the machine, before the
 * run ends (see the head of this file), once they said yes to the question.
 * Nothing happens — and nobody is waited for — when the rung is off,
 * ULTRASEARCH_HUMAN_ASK is never, ULTRASEARCH_HUMAN_TIMEOUT_MS is 0, no window
 * can be shown, or no page needs it. On "Later", or no answer — and, unasked,
 * under `searchFirst` with ULTRASEARCH_HUMAN_ASK=ask — every page comes back
 * `skipped`, and nothing came forward.
 */
export async function handOffDuringRun(dir: string, opts: HandOffDuringRunOptions): Promise<HumanResult[]> {
  if (opts.browser === "off") return [];
  const env = opts.env ?? process.env;
  const mode = humanAskMode(env[HUMAN_ASK_ENV] ?? "ask");
  if (mode === "never") return [];
  const timeoutMs = humanTimeoutMs(opts.env);
  if (timeoutMs === undefined || !(opts.canShow ?? (() => canShowBrowserWindow()))()) return [];
  let candidates: HumanCandidate[];
  let notes: string[];
  try {
    const { sources, manifest } = readDossier(dir);
    candidates = challengeCandidates(dir, sources, manifest);
    notes = manifest.notes ?? [];
  } catch {
    return [];
  }
  const seen = new Set(candidates.map((c) => c.url));
  for (const c of opts.refused ?? []) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    candidates.push(c);
  }
  if (!candidates.length) return [];
  // An agent's run: its web search finds another copy sooner than a person
  // solves a challenge, and the person is asked only about what it cannot find.
  if (opts.searchFirst && mode === "ask") {
    const note =
      `look for another copy with your web search first (ingest it with "citeUrl" set to this page), ` +
      `then \`ultrasearch human --run ${dir}\` for what is still walled`;
    return candidates.map((c) => ({ ...c, outcome: "skipped" as const, note }));
  }
  let answer: HumanAnswer | undefined;
  if (mode === "ask") {
    opts.tell(
      `ultrasearch: ${candidates.length} page(s) stopped at a human check (a CAPTCHA, an anti-bot page). ` +
        `A dialog asks the person at this machine whether to solve them now; nothing comes forward unless they say yes ` +
        `(${HUMAN_ASK_ENV}=always hands them over unasked, never skips this).`,
    );
    answer = await (opts.ask ?? ((pages) => askHuman(pages)))(
      candidates.map((c) => ({ url: c.url, check: c.check ?? notes.find((n) => mentions(n, c.url) && challengeIn(n)) ?? c.why })),
    ).catch((): HumanAnswer => "unavailable");
    if (answer === "later" || answer === "no-answer") {
      const note = `${answer === "later" ? "left for later by the person" : "nobody answered the question"} — \`ultrasearch human --run ${dir}\``;
      opts.tell(`ultrasearch: human: ${answer === "later" ? "later" : "no answer"} — nothing was brought forward.`);
      return candidates.map((c) => ({ ...c, outcome: "skipped" as const, note }));
    }
  }
  opts.tell(
    `ultrasearch: ${answer ? "" : `${candidates.length} page(s) stopped at a human check (a CAPTCHA, an anti-bot page). `}` +
      `The browser comes forward on each in turn: get past it there and the read goes on by itself — up to ${Math.round(timeoutMs / 1000)} s each ` +
      `(${HUMAN_TIMEOUT_ENV}=0 never waits during a run).`,
  );
  const results = await runHuman(dir, candidates, {
    timeoutMs,
    stopAfterTimeout: true,
    ...(opts.firecrawl ? { firecrawl: opts.firecrawl } : {}),
    onResult: (r) => opts.tell(`ultrasearch: human: ${r.id}\t${r.url}\t${r.outcome}${r.outcome === "skipped" && r.note ? ` — ${r.note}` : ""}`),
  });
  // A yes is told how it went, where the question was: the run goes on.
  if (answer === "solve") {
    const cleared = results.filter((r) => r.outcome === "repaired" || r.outcome === "added").length;
    await (opts.notify ?? ((c, t) => notifyHumanDone(c, t)))(cleared, candidates.length).catch(() => false);
  }
  return results;
}

/** A page `fetch` / `ingest` refused because a challenge stopped its read, as a candidate; undefined for any other refusal. */
export function refusedForChallenge(url: string, note: string | undefined): HumanCandidate | undefined {
  const found = challengeIn(note);
  return found ? { id: "-", url, why: `refused — ${found}`, ...(note ? { check: note } : {}) } : undefined;
}
