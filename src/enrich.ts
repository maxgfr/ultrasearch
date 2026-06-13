import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendKind, RawSource } from "./types.js";
import { readDossier, buildSource, renderSourceExtract, renderDossierMarkdown } from "./dossier.js";
import { getMode } from "./modes/registry.js";
import { fetchAndExtract, bestExcerpt } from "./backends/fetch.js";
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
  opts: { question?: string; title?: string; backend?: BackendKind } = {},
): Promise<EnrichResult> {
  const { sources, manifest } = readDossier(dir);
  const question = opts.question ?? manifest.question;

  const canon = canonicalizeUrl(url);
  const existing = sources.find((s) => s.canonicalUrl === canon);
  if (existing) {
    return { id: existing.id, added: false, note: `already in dossier as ${existing.id}` };
  }

  const { text, title, note } = await fetchAndExtract(url);
  if (!text || !text.trim()) {
    return { id: "", added: false, note: note ?? `no readable content at ${url}` };
  }

  const id = `S${sources.reduce((max, s) => Math.max(max, Number(/^S(\d+)$/.exec(s.id)?.[1] ?? 0)), 0) + 1}`;
  const backend: BackendKind = opts.backend ?? "claude";
  const raw: RawSource = {
    url,
    title: opts.title || title || url,
    backend,
    score: 0,
    snippet: bestExcerpt(text, question),
    text,
  };
  const s = buildSource(raw, id, new Date().toISOString(), question);
  writeFileSync(join(dir, s.extract), renderSourceExtract(s, text, manifest.depth));

  const nextSources = [...sources, s];
  const backendsUsed = [...new Set([...manifest.backendsUsed, backend])];
  const nextManifest = { ...manifest, sourceCount: nextSources.length, backendsUsed };
  writeFileSync(join(dir, "sources.json"), JSON.stringify(nextSources, null, 2));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(nextManifest, null, 2));
  writeFileSync(
    join(dir, "DOSSIER.md"),
    renderDossierMarkdown(nextSources, nextManifest, getMode(nextManifest.mode).template),
  );

  return { id, added: true };
}
