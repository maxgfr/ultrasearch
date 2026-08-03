import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpGet, sleep, PAGE_DELAY_MS } from "./fetch.js";
import { canonicalizeUrl } from "../util.js";
import { acceptLanguageHeader } from "../locale.js";

// The docker-compose stack publishes SearXNG on this port. It gets a DEFAULT
// base — like Firecrawl and unlike the historical opt-in — because the probe
// below caps the cost of an absent instance at one refused connection per
// process. Without a default, `docker compose --profile search up -d` brought
// the container up and nothing ever queried it: the flag was mandatory and
// silent about it.
export const SEARXNG_DEFAULT_BASE = "http://localhost:8888";

// Same hard ceiling as Firecrawl's probe: a dead localhost costs milliseconds
// (connection refused), a blackholed host at most this.
const PROBE_TIMEOUT_MS = 2000;

/**
 * Resolve the SearXNG base: an explicit `--searxng` wins, else
 * `ULTRASEARCH_SEARXNG`, else the localhost default. The literal value `off`
 * (either source) disables SearXNG entirely and returns null.
 */
export function resolveSearxngBase(ctx: { options: { searxng?: string } }): string | null {
  const raw = (ctx.options.searxng ?? process.env.ULTRASEARCH_SEARXNG ?? SEARXNG_DEFAULT_BASE).trim();
  if (!raw || raw.toLowerCase() === "off") return null;
  return raw.replace(/\/+$/, "");
}

/** True when the base came from the user (flag or env) rather than the default. */
export function searxngIsExplicit(ctx: { options: { searxng?: string } }): boolean {
  return !!(ctx.options.searxng ?? process.env.ULTRASEARCH_SEARXNG);
}

// One probe per base per process, keyed by base so a test (or a run pointed at
// two instances) is never served another base's verdict.
const probeCache = new Map<string, Promise<boolean>>();

/**
 * Is a SearXNG instance answering at `base`? `GET {base}/healthz` with a hard
 * 2s ceiling; ANY HTTP response counts as up (a 404 from a proxy in front of it
 * still proves something is listening). Connection refused / timeout ⇒ down.
 * Memoised for the process. Never throws.
 *
 * Deliberately bypasses `httpGet`, whose retry-with-backoff would turn a 2s
 * ceiling into ~4.6s on a blackholed host. A probe wants a single shot.
 */
export function probeSearxng(base: string): Promise<boolean> {
  let p = probeCache.get(base);
  if (!p) {
    p = (async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/healthz`, { signal: ctrl.signal });
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

/** Test seam: forget memoised probe verdicts. */
export function resetSearxngProbeCache(): void {
  probeCache.clear();
}

// Discovery via a SearXNG instance's JSON API (keyless, self-hosted). Returns
// candidate URLs (title + snippet, no full text — the gatherer fetches the
// pages). Many public instances disable format=json, so this falls through
// silently (empty + a note) when unreachable or non-JSON.
export const searxngBackend: Backend = async (ctx): Promise<BackendResult> => {
  const base = resolveSearxngBase(ctx);
  if (!base) {
    return {
      backend: "searxng",
      items: [],
      notes: ["SearXNG disabled (--searxng off / ULTRASEARCH_SEARXNG=off). Skipping."],
    };
  }
  // Cheap gate before the real query: an absent instance costs one refused
  // connection instead of a full 8s request timeout per page.
  if (!(await probeSearxng(base))) {
    return {
      backend: "searxng",
      items: [],
      notes: [
        searxngIsExplicit(ctx)
          ? `SearXNG not reachable at ${base}. Skipping; consider your own WebSearch.`
          : `SearXNG not running at ${base} — start it with \`ultrasearch searxng up\` (or \`docker compose --profile search up -d\`) for a local, keyless discovery backend. Skipping.`,
      ],
    };
  }
  const pages = Math.max(1, ctx.options.pages ?? 1);
  const acceptLanguage = acceptLanguageHeader(ctx.options.lang, ctx.options.region);
  const perPage = ctx.options.perSource * 2;
  const base0 = `${base}/search?q=${encodeURIComponent(ctx.question)}&format=json&safesearch=1${
    ctx.options.lang ? `&language=${encodeURIComponent(ctx.options.lang)}` : ""
  }${ctx.options.since ? `&time_range=year` : ""}`;
  const seen = new Set<string>();
  const found: { url: string; title: string; snippet: string }[] = [];
  // SearXNG paginates with `&pageno=` (1-based). Accumulate + dedupe across pages
  // and stop when a page adds no new URLs.
  for (let p = 0; p < pages; p++) {
    const url = base0 + (p > 0 ? `&pageno=${p + 1}` : "");
    const r = await httpGet(url, { accept: "application/json", acceptLanguage, timeoutMs: 8000 });
    if (!r.ok) {
      if (p === 0) {
        const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `unreachable (status ${r.status})`;
        return {
          backend: "searxng",
          items: [],
          notes: [`SearXNG ${why} at ${base}. Skipping; consider your own WebSearch.`],
        };
      }
      break;
    }
    let data: any;
    try {
      data = JSON.parse(r.body);
    } catch {
      if (p === 0) {
        return {
          backend: "searxng",
          items: [],
          notes: [`SearXNG at ${base} did not return JSON (the instance likely disables format=json).`],
        };
      }
      break;
    }
    const results: any[] = Array.isArray(data?.results) ? data.results : [];
    const before = found.length;
    for (const x of results.slice(0, perPage)) {
      if (!x?.url || typeof x.url !== "string") continue;
      const key = canonicalizeUrl(x.url);
      if (seen.has(key)) continue;
      seen.add(key);
      // `||` (not `??`): some SearXNG engines return an empty title — degrade to
      // the URL like the HTML backends, never emit a blank title.
      found.push({ url: x.url, title: String(x.title || x.url), snippet: String(x.content ?? "").slice(0, 360) });
    }
    if (found.length === before) break;
    if (p < pages - 1 && PAGE_DELAY_MS) await sleep(PAGE_DELAY_MS);
  }
  const items: RawSource[] = found.map((f, i) => ({
    url: f.url,
    title: f.title,
    backend: "searxng",
    score: found.length - i,
    snippet: f.snippet,
    lang: ctx.options.lang,
  }));
  return {
    backend: "searxng",
    items,
    notes: items.length ? [`SearXNG returned ${items.length} result(s).`] : [`SearXNG returned no results.`],
  };
};
