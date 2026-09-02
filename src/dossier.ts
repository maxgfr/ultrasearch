import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest, RawSource, Source } from "./types.js";
import { UNDER_COVERED_MIN } from "./types.js";
import { canonicalizeUrl, domainOf, trustScore } from "./util.js";
import { sourceSignals } from "./authority.js";
import { ensureDir, isNoWrite, writeArtifact } from "./no-write.js";
import { toBibtex } from "./bibtex.js";
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

// The same contract for a run that wrote nothing: there is no sources.json to
// point at, and no `check` to enforce it. Saying so is the honest move — a brief
// that threatens a gate which cannot run teaches the reader the gate is bluffing.
export const CITATION_RULES_NO_WRITE = [
  "**Cite every factual claim** with the id of the source it rests on, e.g. `[S1]`",
  "(multiple sources: `[S1][S4]`). The ids are listed below, and each source's full",
  "extract is streamed after this brief.",
  "",
  "If you state something from your **own background knowledge** that no fetched",
  "source backs, you must FLAG it as unverified — either end the sentence with",
  "`[M]`, or put the passage in a `> [model-hint] …` blockquote.",
  "",
  "**Nothing was written, so `ultrasearch check` cannot run here.** The mechanical",
  "gate that normally catches a dangling `[S#]` or an unsourced sentence is absent:",
  "the discipline is entirely yours. Never state anything the extracts do not say.",
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

// The highest "S<n>" number a dossier already uses. Exported so a batch ingest
// can allocate ids serially IN MEMORY (`S${++maxId}`) without re-deriving this
// from the whole list per source — and, more importantly, without the two
// having to agree by coincidence: both go through the same parse.
export function maxSourceId(sources: Source[]): number {
  return sources.reduce((acc, s) => Math.max(acc, idNum(s.id)), 0);
}

// The next free "S<n>" id given the existing sources (used by `fetch`).
export function nextSourceId(sources: Source[]): string {
  return `S${maxSourceId(sources) + 1}`;
}

// Build a Source record (no file written) from a backend's RawSource.
export function buildSource(rs: RawSource, id: string, builtAt: string, question: string): Source {
  const text = rs.text ?? rs.snippet ?? "";
  const trust = trustScore(rs.url, rs.backend);
  // Structural signals, computed from the text we already hold and from how
  // many backends agreed — no host list, no phrase list. Guidance only.
  const signals = sourceSignals({
    url: rs.url,
    text,
    corroboration: typeof rs.meta?.foundBy === "number" ? rs.meta.foundBy : 1,
  }).notes;
  return {
    id,
    url: rs.url,
    canonicalUrl: canonicalizeUrl(rs.url),
    title: rs.title || rs.url,
    backend: rs.backend,
    fetchedAt: builtAt,
    lang: rs.lang,
    domain: domainOf(rs.url),
    trust,
    ...(signals.length ? { signals } : {}),
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

// Persist one source's cleaned extract as sources/S#.md.
export function writeSourceExtract(dir: string, s: Source, text: string, depth: Manifest["depth"]): void {
  writeArtifact(join(dir, s.extract), renderSourceExtract(s, text, depth));
}

// Persist the three index files every reader of a dossier depends on:
// sources.json (what `check` validates against), manifest.json, and DOSSIER.md
// (the model-facing brief). Shared by writeDossier and the `fetch`/enrich path,
// which used to hand-roll its own copy of these three writes and could drift.
export function writeDossierIndex(dir: string, sources: Source[], manifest: Manifest, template: string): DossierPaths {
  const sourcesJson = join(dir, "sources.json");
  const dossierMd = join(dir, "DOSSIER.md");
  const manifestJson = join(dir, "manifest.json");
  writeArtifact(sourcesJson, JSON.stringify(sources, null, 2));
  writeArtifact(manifestJson, JSON.stringify(manifest, null, 2));
  writeArtifact(dossierMd, renderDossierMarkdown(sources, manifest, template));
  return { dir, sourcesJson, dossierMd, manifestJson };
}

// The research mode's extra: a BibTeX file built from the scholarly sources.
// Called by both producers of a dossier (`gather` and `merge`) — it lived
// duplicated verbatim in each before.
export function writeBibtex(dir: string, sources: Source[], extras: readonly string[]): void {
  if (!extras.includes("bibtex")) return;
  writeArtifact(join(dir, "refs.bib"), toBibtex(sources));
}

// Persist a run's dossier: sources/S#.md (cleaned extracts) plus the three index
// files. The tiered reports (SUMMARY/REPORT.md) are written by the model
// afterward, then `render` + `check` run.
export function writeDossier(dir: string, rawSources: RawSource[], manifest: Manifest, template: string): WriteDossierResult {
  ensureDir(join(dir, "sources"));

  const sources: Source[] = rawSources.map((rs, i) => {
    const id = `S${i + 1}`;
    const s = buildSource(rs, id, manifest.builtAt, manifest.question);
    writeSourceExtract(dir, s, rs.text ?? rs.snippet ?? "", manifest.depth);
    return s;
  });

  const m: Manifest = { ...manifest, sourceCount: sources.length };
  return { dir, sources, paths: writeDossierIndex(dir, sources, m, template) };
}

// The model-facing dossier digest: the run's facts, the template to fill, the
// grounding rules, and every source with its id/snippet to cite.
//
// It consults the no-write gate rather than taking a flag, because all four
// callers would otherwise have to thread one. Under it the brief must not tell
// the reader to write REPORT.md, run `check`, or `fetch --url` a gap: none of
// those exist in a read-only phase, and a brief that prescribes impossible steps
// is worse than one that prescribes none.
export function renderDossierMarkdown(sources: Source[], manifest: Manifest, template: string): string {
  const noWrite = isNoWrite();
  const enrich = noWrite
    ? "Search further yourself (your own WebSearch) and read those pages directly"
    : "Top them up (another WebSearch round + `ingest --run <dir> --web-results <f.json>`)";
  const out: string[] = [];
  out.push(`# Search dossier`);
  out.push("");
  out.push(`**Question:** ${manifest.question}`);
  out.push(
    `**Mode:** ${manifest.mode} · **depth:** ${manifest.depth} · **lang:** ${manifest.lang} · ` +
      `**sources:** ${sources.length} · **built:** ${manifest.builtAt}`,
  );
  out.push(`**Backends used:** ${manifest.backendsUsed.join(", ") || "none"}`);
  if (manifest.searchProfile) out.push(`**Search profile:** ${manifest.searchProfile}`);
  out.push("");
  // The WebSearch lane, stated in the dossier itself. A run that had no lane is
  // the case worth surfacing: the strongest engine available to the reader sat
  // idle while scrapers did its job, and nothing else would ever say so.
  if (manifest.webSearch) {
    const ws = manifest.webSearch;
    out.push(
      ws.supplied
        ? `**WebSearch lane:** ${ws.supplied} agent-supplied hit(s) → ${ws.kept} kept` + (ws.rejected ? ` (${ws.rejected} rejected as unusable)` : "")
        : `> 🔎 **No WebSearch lane** — discovery ran on the keyless engines alone, and those are best-effort. ` +
            `If you have a WebSearch tool, search yourself and fold the hits in with \`ingest --run <dir> --web-results <f.json>\`; ` +
            `next time, pass them to \`gather --web-results\` from the start.`,
    );
    out.push("");
  }
  if (manifest.recallFloor) {
    out.push(
      `> ⚠ **Thin dossier** — only ${manifest.recallFloor.count} on-topic source(s) were retrieved ` +
        `(recall floor ${manifest.recallFloor.floor}). ${enrich} BEFORE answering, ` +
        `or the answer will rest on too little evidence.`,
    );
    out.push("");
  }
  if (manifest.coverage?.under.length) {
    out.push(
      `> 🔍 **Under-covered** — \`${manifest.coverage.under.join("`, `")}\`: fewer than ${UNDER_COVERED_MIN} of the ` +
        `top sources mention these terms from your question. ${enrich} before answering, ` +
        `or state the gap explicitly under "Open questions".`,
    );
    out.push("");
  }
  out.push(
    noWrite
      ? `> Nothing was written — every source's full extract follows this brief on stdout. ` +
          `Answer the question directly from them, in the shape of the template below ` +
          `(use every relevant source and end with an "Open questions / contradictions" ` +
          `section). Do not answer from memory.`
      : `> Write two tiers from these sources: \`SUMMARY.md\` (TL;DR) and \`REPORT.md\` ` +
          `(the full template below, filled exhaustively — use every relevant source and end ` +
          `with an "Open questions / contradictions" section). ` +
          `Then run \`render\` and \`check\`. Do not answer from memory.`,
  );
  out.push("");
  out.push(`## Grounding rules`);
  out.push("");
  out.push(noWrite ? CITATION_RULES_NO_WRITE : CITATION_RULES);
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
  out.push(
    `> **You are the judge of these sources.** This engine ranks for RELEVANCE and keeps everything it ` +
      `retrieved — it holds no list of "good" websites, and \`trust\` below reflects only the ROUTE a source ` +
      `arrived by (a scholarly API vouches for a record; a web engine vouches for nothing). Deciding what is ` +
      `authoritative is your job, and you are the only party here who can actually read the page.`,
  );
  out.push(`>`);
  out.push(
    `> As you read each extract, appraise it: is this the primary source (a spec, a vendor's own docs, the ` +
      `paper), secondary reporting, or content marketing rewriting someone else's work? Prefer the primary ` +
      `one for a load-bearing claim, and when only a weak source carries a claim, **say so in the report** ` +
      `rather than leaning on it silently. Discarding a page you judge worthless is a legitimate reading ` +
      `decision — the engine deliberately did not make it for you.`,
  );
  out.push("");
  if (sources.some((s) => s.signals?.length)) {
    out.push(
      `> Each source carries three **measured facts** — how many external sources it cites, how many engines ` +
        `independently surfaced it, whether it declares a persistent identity. They are counts, not verdicts: ` +
        `a page citing nothing can be the primary source (a spec, an API reference), and a page citing plenty ` +
        `can be a rewrite. Use them to decide what to open first, then judge from the text.`,
    );
    out.push("");
  }
  if (sources.length === 0) {
    out.push(
      noWrite
        ? `_No sources were retrieved. Broaden the query, add backends, or search yourself with your own WebSearch._`
        : `_No sources were retrieved. Search yourself and feed the hits in — \`gather --web-results <f.json>\`, or \`ingest --run <dir> --web-results <f.json>\` on this dossier — then widen with \`--search full\`._`,
    );
  }
  for (const s of sources) {
    out.push(`### [${s.id}] ${s.title}`);
    const quality = s.fullText === false ? " · ⚠ snippet only (page fetch failed)" : "";
    // Under no-write `sources/S#.md` is a stream label, not a path on disk.
    const where = noWrite ? `extract: streamed as \`${s.extract}\`` : `extract: \`${s.extract}\``;
    out.push(`url: ${s.url} · backend: ${s.backend} · trust: ${s.trust} · ${where}${quality}`);
    // Measured facts about the document, on their own line. Never a verdict —
    // they cost one line per source and let the reader judge without opening
    // every extract first.
    for (const sig of s.signals ?? []) out.push(`_${sig}_`);
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
