import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest, RawSource, Source } from "./types.js";
import { canonicalizeUrl, domainOf, trustScore } from "./util.js";
import { focusedSnippet, capExtract } from "./backends/fetch.js";

// The grounding contract, inlined into DOSSIER.md so the model writing the
// tiers has the rules in front of it. `check` enforces exactly this.
export const CITATION_RULES = [
  "**Cite every factual claim** with the id of the source it rests on, e.g. `[S1]`",
  "(multiple sources: `[S1][S4]`). The ids are listed below and in `sources.json`.",
  "",
  "If you state something from your **own background knowledge** that no fetched",
  "source backs, you must FLAG it as unverified — either end the sentence with",
  "`[M]`, or put the passage in a `> [model-hint] …` blockquote. `ultrasearch check`",
  "tolerates flagged hints but FAILS on any *unmarked* unsourced claim, and on any",
  "`[S#]` that does not resolve to a real source.",
].join("\n");

// Read + JSON.parse a file, rethrowing a message that names WHAT was being read
// and WHERE. A corrupt sources.json / manifest / verdicts file then surfaces as a
// clean `ultrasearch: <what> is unreadable …` (via main().catch) instead of a raw
// SyntaxError stack. Shared by every reader that parses a dossier artifact.
export function readJson<T>(path: string, what: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`${what} could not be read (${path}): ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`${what} is not valid JSON (${path}): ${(e as Error).message}`);
  }
}

// Parse the numeric suffix of an "S<n>" id.
function idNum(id: string): number {
  const m = /^S(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

// The next free "S<n>" id given the existing sources (used by `fetch`).
export function nextSourceId(sources: Source[]): string {
  const max = sources.reduce((acc, s) => Math.max(acc, idNum(s.id)), 0);
  return `S${max + 1}`;
}

// Build a Source record (no file written) from a backend's RawSource.
export function buildSource(rs: RawSource, id: string, builtAt: string, question: string): Source {
  const text = rs.text ?? rs.snippet ?? "";
  return {
    id,
    url: rs.url,
    canonicalUrl: canonicalizeUrl(rs.url),
    title: rs.title || rs.url,
    backend: rs.backend,
    fetchedAt: builtAt,
    lang: rs.lang,
    domain: domainOf(rs.url),
    trust: trustScore(rs.url, rs.backend),
    score: Number(rs.score.toFixed(4)),
    extract: `sources/${id}.md`,
    // A richer multi-sentence digest snippet when we have full text; a backend's
    // own snippet (already short) is used as-is. Capped modestly for the digest.
    snippet: (rs.snippet || focusedSnippet(text, question, { maxChars: 480, maxSentences: 3 })).slice(0, 480),
    meta: rs.meta,
    // Only record the flag when we positively know the page fetch failed; absent
    // (the common case, incl. enrich/search callers) means full text on file.
    ...(rs.fullText === false ? { fullText: false } : {}),
  };
}

// The on-disk content of sources/S#.md: a small header + the cleaned, depth-
// capped extract. Shared by writeDossier and the `fetch`/enrich path.
export function renderSourceExtract(s: Source, text: string, depth: Manifest["depth"]): string {
  const head = [
    `# ${s.id} — ${s.title}`,
    `- url: ${s.url}`,
    `- backend: ${s.backend} · fetched: ${s.fetchedAt} · trust: ${s.trust} · score: ${s.score}`,
    "",
  ].join("\n");
  return head + capExtract(text, depth) + "\n";
}

// Inverse of renderSourceExtract: recover a source's cleaned text from its
// on-disk extract. The writer emits exactly three header lines (# id — title /
// - url: / - backend:) then the body, so strip those. Defensive — if the header
// isn't where expected (a hand-written/legacy extract), fall back to the whole
// file, then to the snippet, so a malformed extract never crashes a reader.
export function readSourceText(dir: string, s: Source): string {
  const p = join(dir, s.extract);
  if (!existsSync(p)) return s.snippet ?? "";
  const lines = readFileSync(p, "utf8").split("\n");
  const hasHeader = lines.length >= 3 && lines[0]!.startsWith("# ") && lines[1]!.startsWith("- url:") && lines[2]!.startsWith("- backend:");
  const body = (hasHeader ? lines.slice(3) : lines).join("\n").trim();
  return body || s.snippet || "";
}

export interface DossierPaths {
  dir: string;
  sourcesJson: string;
  dossierMd: string;
  manifestJson: string;
}

export interface WriteDossierResult {
  dir: string;
  sources: Source[];
  paths: DossierPaths;
}

// Persist a run's dossier: sources.json (what `check` validates against),
// sources/S#.md (cleaned extracts), manifest.json, and DOSSIER.md (the
// model-facing brief). The tiered reports (SUMMARY/REPORT.md) are written
// by the model afterward, then `render` + `check` run.
export function writeDossier(dir: string, rawSources: RawSource[], manifest: Manifest, template: string): WriteDossierResult {
  mkdirSync(join(dir, "sources"), { recursive: true });

  const sources: Source[] = rawSources.map((rs, i) => {
    const id = `S${i + 1}`;
    const s = buildSource(rs, id, manifest.builtAt, manifest.question);
    writeFileSync(join(dir, s.extract), renderSourceExtract(s, rs.text ?? rs.snippet ?? "", manifest.depth));
    return s;
  });

  const m: Manifest = { ...manifest, sourceCount: sources.length };
  const sourcesJson = join(dir, "sources.json");
  const dossierMd = join(dir, "DOSSIER.md");
  const manifestJson = join(dir, "manifest.json");
  writeFileSync(sourcesJson, JSON.stringify(sources, null, 2));
  writeFileSync(manifestJson, JSON.stringify(m, null, 2));
  writeFileSync(dossierMd, renderDossierMarkdown(sources, m, template));

  return { dir, sources, paths: { dir, sourcesJson, dossierMd, manifestJson } };
}

// The model-facing dossier digest: the run's facts, the template to fill, the
// grounding rules, and every source with its id/snippet to cite.
export function renderDossierMarkdown(sources: Source[], manifest: Manifest, template: string): string {
  const out: string[] = [];
  out.push(`# Search dossier`);
  out.push("");
  out.push(`**Question:** ${manifest.question}`);
  out.push(
    `**Mode:** ${manifest.mode} · **depth:** ${manifest.depth} · **lang:** ${manifest.lang} · ` +
      `**sources:** ${sources.length} · **built:** ${manifest.builtAt}`,
  );
  out.push(`**Backends used:** ${manifest.backendsUsed.join(", ") || "none"}`);
  out.push("");
  if (manifest.recallFloor) {
    out.push(
      `> ⚠ **Thin dossier** — only ${manifest.recallFloor.count} on-topic source(s) were retrieved ` +
        `(recall floor ${manifest.recallFloor.floor}). Enrich the thin areas with your own WebSearch + ` +
        `\`fetch --url\` BEFORE writing, or the report will rest on too little evidence.`,
    );
    out.push("");
  }
  out.push(
    `> Write two tiers from these sources: \`SUMMARY.md\` (TL;DR) and \`REPORT.md\` ` +
      `(the full template below, filled exhaustively — use every relevant source and end ` +
      `with an "Open questions / contradictions" section). ` +
      `Then run \`render\` and \`check\`. Do not answer from memory.`,
  );
  out.push("");
  out.push(`## Grounding rules`);
  out.push("");
  out.push(CITATION_RULES);
  out.push("");
  out.push(`## Report template (${manifest.mode})`);
  out.push("");
  out.push("```markdown");
  out.push(template);
  out.push("```");
  if (manifest.extras.length) {
    out.push("");
    out.push(`_Also produce: ${manifest.extras.join(", ")}._`);
  }
  out.push("");

  if (manifest.notes.length) {
    out.push(`## Retrieval notes`);
    out.push("");
    for (const n of manifest.notes) out.push(`- ${n}`);
    out.push("");
  }

  out.push(`## Sources`);
  out.push("");
  if (sources.length === 0) {
    out.push(`_No sources were retrieved. Broaden the query, add backends, or enrich with your own WebSearch via \`fetch --url\`._`);
  }
  for (const s of sources) {
    out.push(`### [${s.id}] ${s.title}`);
    const quality = s.fullText === false ? " · ⚠ snippet only (page fetch failed)" : "";
    out.push(`url: ${s.url} · backend: ${s.backend} · trust: ${s.trust} · extract: \`${s.extract}\`${quality}`);
    out.push("");
    out.push(s.snippet);
    out.push("");
  }
  return out.join("\n");
}

// Read back a persisted dossier (for check / render / enrich).
export function readDossier(dir: string): { sources: Source[]; manifest: Manifest } {
  const sources = readJson<Source[]>(join(dir, "sources.json"), "sources.json");
  // Valid JSON that isn't an array (a `{}`/`null`/scalar) would crash every
  // caller's `sources.map` with a raw TypeError — surface a clean named error
  // instead (main().catch prints it), keeping the never-crash-on-malformed rule.
  if (!Array.isArray(sources)) {
    throw new Error(`sources.json in ${dir} is not a JSON array — re-run \`ultrasearch gather\`.`);
  }
  const manifest = readJson<Manifest>(join(dir, "manifest.json"), "manifest.json");
  return { sources, manifest };
}
