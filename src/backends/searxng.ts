import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpGet, sleep, pageDelayMs } from "./fetch.js";
import { canonicalizeUrl } from "../util.js";
import { acceptLanguageHeader } from "../locale.js";
import { searxngBase, searxngIsExplicit } from "../engine.js";

// The base URL, the availability probe and its cache come from the engine —
// they are the same three lines every tool that talks to a local SearXNG needs,
// and this repo is where they were written before being moved there.
//
// What stays here is the BACKEND: how a run turns a question into RawSources —
// the per-source page cap, the `since → time_range` mapping, the score ordering
// and the note wording the dossier quotes. Those are ultrasearch's decisions,
// not the engine's, which is why the engine's own `search()` deliberately does
// none of them.
export { SEARXNG_DEFAULT_BASE, probeSearxng, resetSearxngProbeCache } from "../engine.js";
import { probeSearxng } from "../engine.js";

// Discovery via a SearXNG instance's JSON API (keyless, self-hosted). Returns
// candidate URLs (title + snippet, no full text — the gatherer fetches the
// pages). Many public instances disable format=json, so this falls through
// silently (empty + a note) when unreachable or non-JSON.
export const searxngBackend: Backend = async (ctx): Promise<BackendResult> => {
  const base = searxngBase({ searxng: ctx.options.searxng });
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
        searxngIsExplicit({ searxng: ctx.options.searxng })
          ? `SearXNG not reachable at ${base}. Skipping; consider your own WebSearch.`
          : `SearXNG not running at ${base} — start it with \`ultrasearch searxng up\` for a local, keyless discovery backend. Skipping.`,
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
  // SearXNG answers 200 with an EMPTY result list when its own upstreams have
  // throttled it — it reports them in `unresponsive_engines` instead of failing.
  // Without reading that field, a rate-limited instance is indistinguishable
  // from a query that genuinely has no hits, and the run says "no results" for
  // something that will work again in a few minutes.
  const suspended = new Map<string, string>();
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
    // `[["brave","Suspended: too many requests"],["duckduckgo","CAPTCHA"],…]`
    for (const u of Array.isArray(data?.unresponsive_engines) ? data.unresponsive_engines : []) {
      const [engine, why] = Array.isArray(u) ? u : [u, ""];
      if (engine) suspended.set(String(engine), String(why ?? "").trim());
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
    if (p < pages - 1 && pageDelayMs()) await sleep(pageDelayMs());
  }
  const items: RawSource[] = found.map((f, i) => ({
    url: f.url,
    title: f.title,
    backend: "searxng",
    score: found.length - i,
    snippet: f.snippet,
    lang: ctx.options.lang,
  }));
  // Name the throttled upstreams. Empty results with every engine suspended is a
  // TRANSIENT block, not an empty query — saying "no results" there sends you
  // rewording a question that was fine. The web cascade has already moved on to
  // DuckDuckGo et al. either way (an engine returning nothing never satisfies
  // `perSource`), so this is about telling the truth, not about routing.
  const throttled = [...suspended].map(([engine, why]) => (why ? `${engine} (${why})` : engine));
  const blocked = throttled.length ? ` Upstream engines unavailable: ${throttled.join(", ")}.` : "";
  return {
    backend: "searxng",
    items,
    notes: items.length
      ? [`SearXNG returned ${items.length} result(s).${blocked}`]
      : [
          throttled.length
            ? `SearXNG returned no results — its upstream engines are throttling this instance, which is transient.${blocked} The cascade fell through to the other engines; retry in a few minutes for SearXNG's own recall.`
            : `SearXNG returned no results.`,
        ],
  };
};
