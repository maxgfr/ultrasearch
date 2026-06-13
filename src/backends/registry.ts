import type { Backend, BackendKind, BackendResult, RawSource, RunContext } from "../types.js";
import { rrf, canonicalizeUrl } from "../util.js";
import { searxngBackend } from "./searxng.js";
import { duckduckgoBackend } from "./duckduckgo.js";
import { wikipediaBackend } from "./wikipedia.js";
import { genericBackend } from "./generic.js";
import { fixtureBackend } from "./fixture.js";
import { stackexchangeBackend } from "./stackexchange.js";
import { hackernewsBackend } from "./hackernews.js";
import { githubBackend } from "./github.js";
import { arxivBackend } from "./arxiv.js";
import { crossrefBackend } from "./crossref.js";
import { openalexBackend } from "./openalex.js";
import { semanticscholarBackend } from "./semanticscholar.js";
import { europepmcBackend } from "./europepmc.js";
import { pubmedBackend } from "./pubmed.js";

// Registry of retrieval backends. Each is independent, returns candidate
// sources + honest notes, and never throws (the runner wraps failures into
// notes). "claude" is not a search backend — it's the provenance label for a
// source the agent ingested via `fetch`, so it has no handler here.
const HANDLERS: Partial<Record<BackendKind, Backend>> = {
  searxng: searxngBackend,
  duckduckgo: duckduckgoBackend,
  wikipedia: wikipediaBackend,
  generic: genericBackend,
  fixture: fixtureBackend,
  stackexchange: stackexchangeBackend,
  hackernews: hackernewsBackend,
  github: githubBackend,
  arxiv: arxivBackend,
  crossref: crossrefBackend,
  openalex: openalexBackend,
  semanticscholar: semanticscholarBackend,
  europepmc: europepmcBackend,
  pubmed: pubmedBackend,
};

// Backends that should be queried only ONCE per run regardless of how many
// query variants are planned: rate-limited APIs (one shot to respect anon
// quotas) and query-independent backends (fixture/generic). The rest fan out
// across the variants and have their per-variant lists fused.
const SINGLE_QUERY = new Set<BackendKind>([
  "github",
  "stackexchange",
  "semanticscholar",
  "pubmed",
  "fixture",
  "generic",
]);

// Merge one backend's per-variant result lists into a single ranked list via
// RRF over canonical URL, preferring the copy that carries text.
function mergeVariants(backend: BackendKind, lists: RawSource[][], notes: string[]): BackendResult {
  const ranked = lists.map((l) => [...l].sort((a, b) => b.score - a.score));
  const fused = rrf(ranked, (it) => canonicalizeUrl(it.url));
  const best = new Map<string, RawSource>();
  for (const list of ranked) {
    for (const it of list) {
      const key = canonicalizeUrl(it.url);
      const prev = best.get(key);
      if (!prev) best.set(key, { ...it });
      else if (!prev.text && it.text) best.set(key, { ...it, meta: { ...prev.meta, ...it.meta } });
      else if (it.meta) prev.meta = { ...it.meta, ...prev.meta };
    }
  }
  const items = [...best.values()];
  for (const it of items) it.score = fused.get(canonicalizeUrl(it.url)) ?? 0;
  items.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return { backend, items, notes: [...new Set(notes)] };
}

// Run the given backends concurrently. Multi-query backends fan out across
// ctx.variants and fuse; single-query backends run once. A backend that throws
// or is unknown becomes an empty result + a note — a single failing source
// never sinks the run.
export async function runBackends(kinds: BackendKind[], ctx: RunContext): Promise<BackendResult[]> {
  const variants = ctx.variants.length ? ctx.variants : [ctx.question];
  const tasks = kinds.map(async (kind): Promise<BackendResult> => {
    const handler = HANDLERS[kind];
    if (!handler) {
      return { backend: kind, items: [], notes: [`No handler for backend "${kind}".`], ms: 0 };
    }
    const t0 = Date.now();
    try {
      if (SINGLE_QUERY.has(kind) || variants.length <= 1) {
        const res = await handler(ctx);
        return { ...res, ms: Date.now() - t0 };
      }
      const perVariant = await Promise.all(
        variants.map((q) => handler({ ...ctx, question: q })),
      );
      const merged = mergeVariants(
        kind,
        perVariant.map((r) => r.items),
        perVariant.flatMap((r) => r.notes),
      );
      return { ...merged, ms: Date.now() - t0 };
    } catch (e) {
      return { backend: kind, items: [], notes: [`${kind} backend failed: ${(e as Error).message}`], ms: Date.now() - t0 };
    }
  });
  return Promise.all(tasks);
}
