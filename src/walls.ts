import { looksLikeJunkExtraction, type ExtractResult } from "./backends/fetch.js";
import { cachedFetchAndExtract } from "./cache.js";
import { cacheMode, setCacheMode } from "./engine.js";

// What a read must carry before it is worth citing — the local layer over the
// engine's wall detector.
//
// The engine's `looksLikeJunkExtraction` is pinned (its bytes are checked
// against a sha256), and it missed the wall that mattered most: PubMed's
// "Cookies must be enabled. Enable cookies for pubmed.ncbi.nlm.nih.gov and
// reload this page to continue." Its "enable cookies" rule is WEAK, so on its
// own it never fires — and 38 notices went into a dossier as their own text,
// with `check` green on every citation. The patterns below are the walls the
// engine does not know, and the length floor is the net under all of them: a
// page that carries fewer than MIN_USEFUL_CHARS characters of prose is not a
// document anyone can check a claim against, whatever it says.

/** Below this many characters of prose (headings excluded), a read is not content. */
export const MIN_USEFUL_CHARS = 300;

// [pattern, kind]. Each one is a wall ON ITS OWN — unlike the engine's weak
// rules — so they are only ever tried on a SHORT text (see wallPattern): an
// article that discusses cookie walls is long, a cookie wall is not.
const LOCAL_WALLS: [RegExp, string][] = [
  [/\bcookies? (must|need to|have to|should) be (enabled|turned on|allowed)\b/i, "cookie wall"],
  [/\benable cookies (for|on|in)\b[\s\S]{0,160}?\b(reload|refresh|continue)\b/i, "cookie wall"],
  [/\b(your browser|this browser) (does not|doesn't) (accept|support) cookies\b/i, "cookie wall"],
  [/\bwe value your privacy\b[\s\S]{0,600}?\b(accept|agree|consent)\b/i, "cookie/consent wall"],
  [/\b(accept|allow) all cookies\b[\s\S]{0,400}?\b(reject|decline|manage|settings|preferences)\b/i, "cookie/consent wall"],
  [/\b(please )?(enable|turn on) javascript\b[\s\S]{0,120}?\b(to continue|to proceed|and reload|and refresh|to view|to use)\b/i, "JavaScript-required shell"],
  [/\byou need to enable javascript to run this app\b/i, "JavaScript-required shell"],
  [/\bpour continuer,? (veuillez )?activer (les cookies|javascript)\b|\bles cookies doivent être activés\b/i, "cookie wall (fr)"],
];

// Only a short text can be a wall: the same ceiling the engine applies.
const WALL_MAX_CHARS = 2000;

/** Characters of prose in a read: heading lines dropped, whitespace collapsed. */
export function usefulChars(text: string): number {
  return text
    .split("\n")
    .filter((l) => !/^\s*#{1,6}\s/.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim().length;
}

// A wall talks TO the reader — "you", "your browser", "accept", "enable",
// "reload" — while the prose of a document talks about its subject. Lines of
// the second kind are what a wall verdict has to outweigh.
const ADDRESSES_READER = /\b(you|your|yours|vous|votre|vos)\b/i;
const ADDRESSES_READER_DE = /\b(Sie|Ihr|Ihre|Ihnen)\b/;
const IMPERATIVE =
  /^\W*(please\s+)?(accept|allow|agree|enable|turn on|reload|refresh|click|tap|continue|manage|reject|decline|sign in|log in|subscribe|veuillez|acceptez|activez|cliquez|continuer)\b/i;

/**
 * True when the text is mostly a document's own prose: three lines or more of
 * 60+ characters that neither address the reader nor are a known wall phrase,
 * carrying at least 60 % of the text. A cookie banner or a "please enable
 * JavaScript" line above three real paragraphs does not make the page a wall —
 * nor does an article that discusses cookie walls, which the engine's own rule
 * (two pattern hits are a wall, whatever surrounds them) calls one.
 */
export function proseOutweighsWall(text: string): boolean {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) => l.length >= 60 && !ADDRESSES_READER.test(l) && !ADDRESSES_READER_DE.test(l) && !IMPERATIVE.test(l) && !LOCAL_WALLS.some(([re]) => re.test(l)),
    );
  if (lines.length < 3) return false;
  const prose = lines.reduce((n, l) => n + l.length, 0);
  return prose >= 0.6 * text.replace(/\s+/g, " ").trim().length;
}

/**
 * The wall a text IS, by its wording: the engine's verdict first, then the
 * local patterns — either one overruled when the text is mostly real prose
 * (`proseOutweighsWall`). No length rule — this is what `check` re-runs on a
 * dossier gathered before the floor existed, where a short extract may
 * legitimately be a snippet.
 */
export function wallPattern(text: string): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const engine = looksLikeJunkExtraction(t);
  const local = engine || t.length >= WALL_MAX_CHARS ? undefined : LOCAL_WALLS.find(([re]) => re.test(t.slice(0, 800)))?.[1];
  const wall = engine ?? local;
  return wall && !proseOutweighsWall(t) ? wall : undefined;
}

/**
 * Why a fresh read is not content, or undefined when it is: a wall by its
 * wording, or a page too thin to carry a claim. The name a read is refused or
 * demoted under, so it reads in a sentence: "extracted to a cookie wall".
 */
export function looksLikeWall(text: string): string | undefined {
  const wall = wallPattern(text);
  if (wall) return wall;
  const n = usefulChars(text);
  return n < MIN_USEFUL_CHARS ? `near-empty page (${n} useful characters)` : undefined;
}

/** True when `looksLikeWall`'s verdict is a wall by wording, not just a thin page. */
export function isWordedWall(reason: string | undefined): boolean {
  return !!reason && !reason.startsWith("near-empty page");
}

// How many reads are currently bypassing the cache. The engine's cache mode is
// process-global, and hydration runs several reads at once: a plain save/restore
// would let the first read to finish switch the bypass off under the others —
// or, finishing in the wrong order, leave it on for the rest of the process.
let bypassing = 0;
let saved: ReturnType<typeof cacheMode> | undefined;

/**
 * A cached read that refuses to serve a cached WALL.
 *
 * The cache stores whatever a read got, and a host that was throttling at the
 * time stored its interstitial: every later read inside the TTL is served the
 * same wall, `--no-cache` or a fresh dossier being the only way past it. So a
 * cached copy that is a wall is re-read live (the engine's refresh mode) — which
 * also overwrites the stored copy when the live read is good.
 */
export async function readPastCachedWall(
  url: string,
  opts: Parameters<typeof cachedFetchAndExtract>[1],
  enabled: boolean,
): Promise<ExtractResult & { cached?: boolean }> {
  const res = await cachedFetchAndExtract(url, opts, enabled);
  if (!res.cached || !res.text?.trim() || !looksLikeWall(res.text)) return res;
  if (bypassing++ === 0) {
    saved = cacheMode();
    setCacheMode({ refresh: true });
  }
  try {
    return await cachedFetchAndExtract(url, opts, enabled);
  } finally {
    if (--bypassing === 0 && saved) {
      setCacheMode(saved);
      saved = undefined;
    }
  }
}
