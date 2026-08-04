import type { Backend, BackendResult, RawSource, WebSearchHit } from "../types.js";

// The harness WebSearch lane. The agent runs its OWN WebSearch tool — the best
// index available to this process, and the only one that needs neither a
// container nor a scrape — and hands the hits over. This backend does not
// search: it turns those hits into candidates and lets the normal pipeline do
// the rest (RRF fusion, hydration ladder, BM25 re-rank, relevance floor,
// near-dup collapse, cap).
//
// Deliberately NO privilege. A hit does not carry `text`, so the page is
// fetched and cleaned like any other; and `claude` gets no authority floor in
// BACKEND_TRUST, so trust still comes from the domain alone. The lane's only
// advantage is its fusion rank — the agent picked these URLs, so they enter
// high — which is exactly the right amount of deference: a bad domain the agent
// happened to pick is still a bad domain.

export type { WebSearchHit };

export interface ParsedWebResults {
  hits: WebSearchHit[];
  rejected: number;
  notes: string[];
}

// Harnesses spell a search hit differently, and an agent transcribing one by
// hand will reach for whichever key it remembers. Accept the whole family
// rather than make the caller guess ours.
const URL_KEYS = ["url", "link", "href", "uri"];
const TITLE_KEYS = ["title", "name", "heading"];
const SNIPPET_KEYS = ["snippet", "description", "summary", "content", "text", "excerpt"];

function firstString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

// Only a real http(s) page can be fetched, hydrated and cited. Anything else
// (a mailto:, a bare phrase the agent pasted, a relative path) is counted as
// rejected and reported — never silently dropped.
function normalizeUrl(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

function hitFrom(entry: unknown): WebSearchHit | undefined {
  if (typeof entry === "string") {
    const url = normalizeUrl(entry);
    return url ? { url } : undefined;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const o = entry as Record<string, unknown>;
  const raw = firstString(o, URL_KEYS);
  if (!raw) return undefined;
  const url = normalizeUrl(raw);
  if (!url) return undefined;
  return {
    url,
    title: firstString(o, TITLE_KEYS),
    snippet: firstString(o, SNIPPET_KEYS),
  };
}

// Pull the array of hits out of whatever the agent handed over: a bare array,
// or a wrapper object under one of the keys a search payload usually uses.
function entriesOf(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    for (const k of ["results", "hits", "items", "webResults", "web_results", "sources"]) {
      const v = (parsed as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v;
    }
  }
  return undefined;
}

/**
 * Parse the `--web-results` payload. Tolerant on purpose: this is the seam
 * between a model's output and the engine, and a run must not die because the
 * agent wrapped its hits in `{results: […]}` or pasted bare URLs. Everything
 * it refuses is COUNTED and explained, so a malformed payload is visible in
 * the dossier instead of quietly halving recall.
 *
 * Accepts: a JSON array of objects, a JSON array of URL strings, a JSON object
 * wrapping either under `results`/`hits`/`items`/…, or a plain newline-separated
 * list of URLs. Duplicate URLs collapse (first wins — the agent's own ranking).
 */
export function parseWebResults(raw: string): ParsedWebResults {
  const text = raw.trim();
  if (!text) return { hits: [], rejected: 0, notes: ["--web-results was empty."] };

  const notes: string[] = [];
  let entries: unknown[] | undefined;
  try {
    entries = entriesOf(JSON.parse(text));
    if (!entries) {
      return { hits: [], rejected: 0, notes: ["--web-results parsed as JSON but held no array of results (expected [{url,title,snippet}, …])."] };
    }
  } catch {
    // Not JSON — fall back to the shape an agent produces when it just pastes
    // what it found: one URL per line.
    entries = text.split(/\r?\n/).filter((l) => l.trim());
    notes.push("--web-results was not JSON — read it as a newline-separated URL list.");
  }

  const hits: WebSearchHit[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const entry of entries) {
    const hit = hitFrom(entry);
    if (!hit) {
      rejected++;
      continue;
    }
    if (seen.has(hit.url)) continue;
    seen.add(hit.url);
    hits.push(hit);
  }
  if (rejected) notes.push(`--web-results: ignored ${rejected} entr${rejected === 1 ? "y" : "ies"} with no usable http(s) URL.`);
  return { hits, rejected, notes };
}

export const websearchBackend: Backend = async (ctx): Promise<BackendResult> => {
  const hits = ctx.options.webResults ?? [];
  if (!hits.length) {
    return {
      backend: "claude",
      items: [],
      notes: ["WebSearch lane: no hits supplied (pass --web-results <file.json|->)."],
    };
  }
  // Rank by the order the agent gave them: it ran the search and knows which
  // hit answered the question. Score is only intra-list ordering — RRF fusion
  // downstream weighs this list exactly like every other backend's.
  const items: RawSource[] = hits.map((h, i) => ({
    url: h.url,
    title: h.title || h.url,
    backend: "claude",
    score: hits.length - i,
    snippet: h.snippet ?? "",
    // No `text`: the page is hydrated by the gatherer through the same rescue
    // ladder as any other candidate, so a WebSearch hit is held to the same
    // evidentiary standard. The snippet is only the fallback when it fails.
  }));
  return {
    backend: "claude",
    items,
    notes: [`WebSearch lane: ${items.length} hit(s) supplied by the agent.`],
  };
};
