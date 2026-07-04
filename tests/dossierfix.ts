import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest, Source } from "../src/types.js";

// Write a minimal valid dossier (sources.json + manifest.json + per-source
// extracts) for check/render/enrich tests, with sources S1..Sn.
export function writeFixtureDossier(dir: string, n: number, over: Partial<Manifest> = {}): Source[] {
  mkdirSync(join(dir, "sources"), { recursive: true });
  const sources: Source[] = Array.from({ length: n }, (_, i) => {
    const id = `S${i + 1}`;
    return {
      id,
      url: `https://src.test/${id}`,
      canonicalUrl: `https://src.test/${id.toLowerCase()}`,
      title: `Source ${id}`,
      backend: "duckduckgo",
      fetchedAt: "2026-06-13T10:00:00.000Z",
      lang: "en",
      domain: "src.test",
      trust: 0.6,
      score: n - i,
      extract: `sources/${id}.md`,
      snippet: `snippet for ${id}`,
    };
  });
  for (const s of sources) {
    writeFileSync(join(dir, s.extract), `# ${s.id}\nsome extract text for ${s.id}\n`);
  }
  const manifest: Manifest = {
    version: "0.1.0",
    question: "what is rate limiting",
    mode: "topic",
    depth: "standard",
    lang: "en",
    backends: ["duckduckgo"],
    backendsUsed: ["duckduckgo"],
    sourceCount: n,
    maxSources: 25,
    builtAt: "2026-06-13T10:00:00.000Z",
    slug: "topic-rl",
    tiers: ["SUMMARY.md", "REPORT.md"],
    extras: [],
    notes: [],
    timings: { total: 1 },
    ...over,
  };
  writeFileSync(join(dir, "sources.json"), JSON.stringify(sources, null, 2));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return sources;
}
