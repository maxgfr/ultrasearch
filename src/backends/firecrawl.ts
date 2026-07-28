import type { Backend, BackendResult, RawSource } from "../types.js";
import { cleanInline, httpJson } from "./fetch.js";

// Self-hosted Firecrawl client — a content-CLEANING layer in front of the
// built-in regex extractor, plus an explicit search backend.
//
// Firecrawl fetches a page with a real headless browser and returns
// main-content markdown. That beats `htmlToText(extractMainHtml(html))` on
// nav/cookie chrome, and it is the only way a JS-rendered page yields any text
// at all. Self-hosted Firecrawl is KEYLESS (`USE_DB_AUTHENTICATION=false`), so
// this stays inside the project's no-keys contract; `/search` is keyless too
// (it cascades Fire-Engine → SearXNG → DuckDuckGo internally).
//
// Bring the stack up with:
//   docker compose --profile search --profile extract up -d --wait
//
// Everything here degrades to a NOTE, never a throw: when Firecrawl is absent
// the caller keeps using the built-in extractor exactly as before.

// The docker-compose stack publishes the API on this port. Unlike SearXNG —
// which is deliberately opt-in so a fresh install never pays a dead-localhost
// timeout — Firecrawl gets a default base, because it is protected by the
// memoised 2s availability probe below: one cheap connection-refused per
// process, then every later call short-circuits.
export const FIRECRAWL_DEFAULT_BASE = "http://localhost:3002";

// The probe's hard ceiling. Deliberately small: a dead localhost must cost
// milliseconds (connection refused), and a blackholed host at most this.
const PROBE_TIMEOUT_MS = 2000;
// A scrape drives a real browser, so it needs a far longer budget than a plain
// httpGet. Firecrawl is also told to give up at the same point (`timeout` in the
// request body) so it doesn't keep working on a page we stopped waiting for.
const SCRAPE_TIMEOUT_MS = 45_000;
const SEARCH_TIMEOUT_MS = 30_000;
// Firecrawl's own server-side page cache: `maxAge` lets it serve a page it
// already scraped within this window instead of re-driving the browser. Matches
// the on-disk fetch cache's 24h TTL (see src/cache.ts).
const SCRAPE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface FirecrawlOptions {
  /** `--firecrawl <url>`; "off" disables Firecrawl entirely. */
  firecrawl?: string;
}

/**
 * Resolve the configured Firecrawl base: an explicit `--firecrawl` wins, else
 * `ULTRASEARCH_FIRECRAWL`, else the localhost default. The literal value `off`
 * (either source) disables Firecrawl entirely and returns null.
 */
export function firecrawlBase(opts: FirecrawlOptions = {}): string | null {
  const raw = (opts.firecrawl ?? process.env.ULTRASEARCH_FIRECRAWL ?? FIRECRAWL_DEFAULT_BASE).trim();
  if (!raw || raw.toLowerCase() === "off") return null;
  return raw.replace(/\/+$/, "");
}

/** True when the base came from the user (flag or env) rather than the default. */
export function firecrawlIsExplicit(opts: FirecrawlOptions = {}): boolean {
  return !!(opts.firecrawl ?? process.env.ULTRASEARCH_FIRECRAWL);
}

// Optional bearer, so the same client can point at Firecrawl Cloud. Not needed
// for the self-hosted stack, which sends no Authorization header at all.
function authHeaders(): Record<string, string> | undefined {
  const key = process.env.ULTRASEARCH_FIRECRAWL_KEY?.trim();
  return key ? { authorization: `Bearer ${key}` } : undefined;
}

// One probe per base per process. Keyed by base so a test (or a run pointed at
// two instances) is never served another base's verdict.
const probeCache = new Map<string, Promise<boolean>>();

/**
 * Is a Firecrawl instance answering at `base`? `GET {base}/` with a hard 2s
 * ceiling; ANY HTTP response counts as up (the root returns 200 `{"message":
 * "Firecrawl API"}`, but a 404 from a proxy in front of it still proves
 * something is listening). Connection refused / timeout ⇒ down. Memoised for
 * the process, so the whole cost of an absent Firecrawl is one refused
 * connection. Never throws.
 *
 * Deliberately bypasses `httpGet`: that layer retries once with a backoff,
 * which would turn a 2s ceiling into ~4.6s on a blackholed host. A probe wants
 * a single shot.
 */
export function probeFirecrawl(base: string): Promise<boolean> {
  let p = probeCache.get(base);
  if (!p) {
    p = (async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/`, { signal: ctrl.signal });
        await res.text().catch(() => ""); // drain so the socket is released
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(t);
      }
    })();
    probeCache.set(base, p);
  }
  return p;
}

// Resolved API prefix per base. Firecrawl 2.10.5 serves `/v2`; older images only
// `/v1`. Rather than spend a discovery round-trip we stay optimistic on `/v2`
// and remember the downgrade the first time a POST 404s (see postJson).
const prefixCache = new Map<string, string>();

/** The API prefix in use for `base`: `/v2` until a 404 proves it is `/v1`. */
export function apiPrefix(base: string): string {
  return prefixCache.get(base) ?? "/v2";
}

// POST a JSON body to `{base}{prefix}{path}`, transparently downgrading /v2 →
// /v1 (once, memoised per base) when the versioned route 404s.
async function postJson(base: string, path: string, body: unknown, timeoutMs: number): Promise<{ ok: boolean; status: number; data: any; error?: string }> {
  const headers = authHeaders();
  const first = await httpJson("POST", `${base}${apiPrefix(base)}${path}`, body, { timeoutMs, headers });
  if (first.status !== 404 || apiPrefix(base) !== "/v2") return first;
  prefixCache.set(base, "/v1");
  return httpJson("POST", `${base}/v1${path}`, body, { timeoutMs, headers });
}

/** A page as Firecrawl returned it: main-content markdown plus provenance. */
export interface FirecrawlScrape {
  markdown: string;
  title?: string;
  sourceURL?: string;
  statusCode?: number;
}

/**
 * PURE mapper for a `/scrape` response body → the fields the extractor needs,
 * or null when there is nothing usable: `{success:false}`, a missing/non-object
 * `data`, or empty markdown. Exported so the response contract is unit-tested
 * against a fixture instead of the network.
 */
export function mapScrapeResponse(json: any): FirecrawlScrape | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  if (json.success === false) return null;
  const data = json.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const markdown = typeof data.markdown === "string" ? data.markdown.trim() : "";
  if (!markdown) return null;
  const meta = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  const rawTitle = typeof meta.title === "string" ? cleanInline(meta.title) : "";
  // sourceURL is the post-redirect URL; `url` is the older field name.
  const src = typeof meta.sourceURL === "string" ? meta.sourceURL : typeof meta.url === "string" ? meta.url : undefined;
  const status = typeof meta.statusCode === "number" ? meta.statusCode : undefined;
  return {
    markdown,
    ...(rawTitle ? { title: rawTitle } : {}),
    ...(src ? { sourceURL: src } : {}),
    ...(status !== undefined ? { statusCode: status } : {}),
  };
}

/** One `web` hit from a `/search` response. */
export interface FirecrawlHit {
  url: string;
  title: string;
  description: string;
  markdown?: string;
}

/**
 * PURE mapper for a `/search` response body → the `web` hits. Tolerates the
 * shape drifting to a bare array or to `data.results`, and drops any entry
 * without a usable URL. Never throws.
 */
export function mapSearchResponse(json: any): FirecrawlHit[] {
  if (!json || typeof json !== "object") return [];
  if (json.success === false) return [];
  const data = json.data;
  const web: unknown = Array.isArray(data) ? data : Array.isArray(data?.web) ? data.web : Array.isArray(data?.results) ? data.results : [];
  const out: FirecrawlHit[] = [];
  for (const x of web as any[]) {
    if (!x || typeof x.url !== "string" || !x.url) continue;
    out.push({
      url: x.url,
      // `||` (not `??`): an empty title degrades to the URL, never blank.
      title: cleanInline(String(x.title || x.url)),
      description: cleanInline(String(x.description ?? x.snippet ?? "")).slice(0, 360),
      ...(typeof x.markdown === "string" && x.markdown.trim() ? { markdown: x.markdown } : {}),
    });
  }
  return out;
}

/** What a scrape attempt tells the caller: the page, or WHY it fell through. */
export interface ScrapeAttempt {
  data?: FirecrawlScrape;
  /**
   * A user-visible reason the caller should surface as a note. Only set when
   * Firecrawl was actually REACHED and still produced nothing — an unreachable
   * or disabled instance is silent (see the note-policy comment in fetch.ts).
   */
  why?: string;
}

/**
 * Scrape one URL through Firecrawl, returning the cleaned markdown or the
 * reason it could not. A single `/scrape` call — never `/batch/scrape`, which is
 * an async job + polling protocol not worth the complexity for one page.
 * Returns `{}` (silently) when Firecrawl is disabled or unreachable.
 */
export async function scrapeViaFirecrawl(url: string, opts: FirecrawlOptions = {}): Promise<ScrapeAttempt> {
  const base = firecrawlBase(opts);
  if (!base) return {};
  if (!(await probeFirecrawl(base))) {
    // Only worth a note when the user asked for a specific instance and did not
    // get it; the localhost default being absent is the normal case.
    return firecrawlIsExplicit(opts) ? { why: `Firecrawl not reachable at ${base} — used the built-in extractor.` } : {};
  }
  const r = await postJson(
    base,
    "/scrape",
    {
      url,
      formats: ["markdown"],
      onlyMainContent: true,
      blockAds: true,
      removeBase64Images: true,
      maxAge: SCRAPE_MAX_AGE_MS,
      timeout: SCRAPE_TIMEOUT_MS,
    },
    SCRAPE_TIMEOUT_MS,
  );
  if (!r.ok) {
    const why = r.status ? `status ${r.status}` : (r.error ?? "no response");
    return { why: `Firecrawl could not scrape ${url} (${why}) — fell back to the built-in extractor.` };
  }
  const data = mapScrapeResponse(r.data);
  if (!data) return { why: `Firecrawl returned no markdown for ${url} — fell back to the built-in extractor.` };
  return { data };
}

/**
 * Query Firecrawl's keyless `/search` (Fire-Engine → SearXNG → DuckDuckGo
 * internally). Returns the `web` hits, or a reason.
 */
export async function searchViaFirecrawl(query: string, limit: number, opts: FirecrawlOptions = {}): Promise<{ hits?: FirecrawlHit[]; why?: string }> {
  const base = firecrawlBase(opts);
  if (!base) return { why: `Firecrawl disabled (--firecrawl off / ULTRASEARCH_FIRECRAWL=off). Skipping.` };
  if (!(await probeFirecrawl(base))) {
    return { why: `Firecrawl not reachable at ${base} (bring it up with \`docker compose --profile search --profile extract up -d --wait\`). Skipping.` };
  }
  const r = await postJson(base, "/search", { query, limit, sources: ["web"] }, SEARCH_TIMEOUT_MS);
  if (!r.ok) {
    const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `unreachable (status ${r.status || 0})`;
    return { why: `Firecrawl search ${why} at ${base}.` };
  }
  return { hits: mapSearchResponse(r.data) };
}

/**
 * Discovery via a self-hosted Firecrawl's `/search`. An EXPLICIT engine only —
 * it is not part of the `auto` cascade, because it needs ~3GB of containers
 * running and its upstream is the same SearXNG the `searxng` backend already
 * queries directly. Reach for it with `--backends firecrawl` or
 * `--web-engine firecrawl` when you want Firecrawl's cleaned markdown to come
 * back WITH the search hits.
 */
export const firecrawlBackend: Backend = async (ctx): Promise<BackendResult> => {
  const { hits, why } = await searchViaFirecrawl(ctx.question, ctx.options.perSource * 2, ctx.options);
  if (!hits) return { backend: "firecrawl", items: [], notes: [why ?? "Firecrawl search returned nothing."] };
  const items: RawSource[] = hits.slice(0, ctx.options.perSource * 2).map((h, i) => ({
    url: h.url,
    title: h.title,
    backend: "firecrawl" as const,
    score: hits.length - i,
    snippet: h.description,
    // Firecrawl only returns page markdown with a search hit when asked to
    // scrape each result; when it does, the gatherer skips re-fetching the page.
    ...(h.markdown ? { text: h.markdown } : {}),
    lang: ctx.options.lang,
  }));
  return {
    backend: "firecrawl",
    items,
    notes: items.length ? [`Firecrawl search returned ${items.length} result(s).`] : [`Firecrawl search returned no results.`],
  };
};
