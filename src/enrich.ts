import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendKind, RawSource } from "./types.js";
import { readDossier, buildSource, renderSourceExtract, renderDossierMarkdown, nextSourceId } from "./dossier.js";
import { getMode } from "./modes/registry.js";
import { bestExcerpt, rescueViaWayback, DEAD_LINK_STATUS } from "./backends/fetch.js";
import { cachedFetchAndExtract } from "./cache.js";
import { canonicalizeUrl } from "./util.js";

export interface EnrichResult {
  id: string;
  added: boolean;
  note?: string;
}

// Ingest a single URL into an existing dossier — the bridge for the agent's own
// WebSearch hits. Fetches + cleans the page, allocates the next S# id, appends
// to sources.json, writes sources/S#.md, and refreshes manifest + DOSSIER.md.
// If the URL is already in the dossier it returns the existing id (no dup).
export async function addSource(
  dir: string,
  url: string,
  opts: { question?: string; title?: string; backend?: BackendKind; cache?: boolean } = {},
): Promise<EnrichResult> {
  const { sources, manifest } = readDossier(dir);
  const question = opts.question ?? manifest.question;

  const canon = canonicalizeUrl(url);
  const existing = sources.find((s) => s.canonicalUrl === canon);
  if (existing) {
    return { id: existing.id, added: false, note: `already in dossier as ${existing.id}` };
  }

  const fetched = await cachedFetchAndExtract(url, {}, !!opts.cache);
  let { text, title } = fetched;
  let waybackSnapshot: string | undefined;
  // A dead origin (404/410/451/403) → try the Wayback Machine's closest snapshot
  // before giving up, so an agent's own WebSearch hit that has since rotted still
  // makes it into the dossier. The ORIGINAL url is kept as the source url.
  if ((!text || !text.trim()) && DEAD_LINK_STATUS.has(fetched.status)) {
    const wb = await rescueViaWayback(url);
    if (wb) {
      text = wb.text;
      title = title || wb.title;
      waybackSnapshot = wb.timestamp;
    }
  }
  if (!text || !text.trim()) {
    return { id: "", added: false, note: fetched.note ?? `no readable content at ${url}` };
  }

  const id = nextSourceId(sources); // shares the S<n> scheme the grounding contract depends on
  const backend: BackendKind = opts.backend ?? "claude";
  const raw: RawSource = {
    url,
    title: opts.title || title || url,
    backend,
    score: 0,
    snippet: bestExcerpt(text, question),
    text,
    ...(waybackSnapshot ? { meta: { waybackSnapshot } } : {}),
  };
  const s = buildSource(raw, id, new Date().toISOString(), question);
  writeFileSync(join(dir, s.extract), renderSourceExtract(s, text, manifest.depth));

  const nextSources = [...sources, s];
  const backendsUsed = [...new Set([...manifest.backendsUsed, backend])];
  const nextManifest = { ...manifest, sourceCount: nextSources.length, backendsUsed };
  writeFileSync(join(dir, "sources.json"), JSON.stringify(nextSources, null, 2));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(nextManifest, null, 2));
  writeFileSync(join(dir, "DOSSIER.md"), renderDossierMarkdown(nextSources, nextManifest, getMode(nextManifest.mode).template));

  return { id, added: true };
}
