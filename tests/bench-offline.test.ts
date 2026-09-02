import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Manifest, RawSource, Verdict } from "../src/types.js";
import { writeDossier } from "../src/dossier.js";
import { getMode } from "../src/modes/registry.js";
import { writeFixtureDossier } from "./dossierfix.js";
import { addSources } from "../src/enrich.js";
import { buildWorklist, reduceVerdicts } from "../src/verify.js";
import { runCheck } from "../src/check.js";
import { writeHtml, writeReportMarkdown } from "../src/render.js";
import { autoRelink } from "../src/relink.js";
import { probeServices } from "../src/services.js";
import { installFetchMock } from "./fetchmock.js";

// Reproducible offline "before/after" instrument for the perf branch that will
// optimise buildWorklist / runCheck / writeHtml+writeReportMarkdown /
// probeServices / addSources / autoRelink. Network AND subprocess free (like
// tests/bench-pdf.test.ts), so it never gates CI and its numbers are comparable
// run to run. Guarded the same way: off unless ULTRASEARCH_BENCH=1
// (`pnpm run bench:offline`).
//
// The document-converter/pdf-inspector probes shell out via `runWithInput`
// (src/backends/exec.js) even with tests/setup.ts's env pins (pdftotext still
// spawns for real) — stub it so probeServices never touches a subprocess here,
// same convention as tests/services-doc.test.ts.
vi.mock("../src/backends/exec.js", () => ({
  runWithInput: vi.fn(async () => ({ ok: false, stdout: "", error: "not installed" })),
  PDF_INSPECTOR_SPEC: "@firecrawl/pdf-inspector@1",
  ANYDOC_SPEC: "@firecrawl/anydoc@0.1",
}));

const SOURCE_COUNT = 150;
const CLAIM_COUNT = 120;
const ENRICH_URLS = 40;
const RELINK_SOURCES = 20;

// Small closed vocabulary + a linear-congruential index walk, so the generated
// prose is deterministic (same bytes every run) without pulling in a corpus.
const WORDS = [
  "latency",
  "throughput",
  "cache",
  "index",
  "cluster",
  "protocol",
  "runtime",
  "schema",
  "pipeline",
  "gateway",
  "token",
  "cursor",
  "replica",
  "shard",
  "ledger",
  "registry",
  "artifact",
  "payload",
  "socket",
  "daemon",
  "kernel",
  "buffer",
  "queue",
  "topology",
  "checksum",
  "manifest",
  "endpoint",
  "interface",
  "module",
  "adapter",
  "worklist",
  "worker",
  "backoff",
  "retry",
  "budget",
  "sampler",
  "profiler",
  "heuristic",
  "batch",
  "stream",
];

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s;
  };
}

// ~5.5 bytes/word average (word + space + occasional punctuation), so
// `targetBytes / 5.5` words lands close to the requested size.
function prose(seed: number, targetBytes: number): string {
  const next = lcg(seed);
  const words = Math.ceil(targetBytes / 5.5);
  const sentences: string[] = [];
  let sentence: string[] = [];
  for (let i = 0; i < words; i++) {
    sentence.push(WORDS[next() % WORDS.length]!);
    if (sentence.length >= 11) {
      sentences.push(cap(sentence.join(" ")) + ".");
      sentence = [];
    }
  }
  if (sentence.length) sentences.push(cap(sentence.join(" ")) + ".");
  return sentences.join(" ");
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// 150 sources, ~30 KB of prose text each, distinct citable https urls/domains.
function buildRawSources(n: number): RawSource[] {
  const out: RawSource[] = [];
  for (let i = 1; i <= n; i++) {
    const text = prose(i * 97 + 13, 30_000);
    out.push({
      url: `https://source${i}.bench-offline.example.org/doc/${i}`,
      title: `Synthetic Source ${i}`,
      backend: "duckduckgo",
      score: 1 - i / (n + 1),
      snippet: text.slice(0, 200),
      text,
    });
  }
  return out;
}

function buildManifest(): Manifest {
  return {
    version: "0.1.0",
    question: "what does the offline hot-path bench measure",
    mode: "topic",
    depth: "deep", // no capExtract truncation — the on-disk extract stays ~30 KB
    lang: "en",
    backends: ["duckduckgo"],
    backendsUsed: ["duckduckgo"],
    sourceCount: 0,
    builtAt: "2026-01-01T00:00:00.000Z",
    slug: "bench-offline",
    tiers: ["SUMMARY.md", "REPORT.md"],
    extras: [],
    notes: [],
    timings: { total: 1 },
  };
}

// ~120 claim sentences (>=6 substantive words each), each its own paragraph
// (so `extractUnits` treats it as its own claim unit), citing 2-3 distinct
// sources as `[S12] [S57]`. Every 4th claim carries a numeral so both
// `runCheck`'s numeral pass and `buildWorklist`'s `numeralsAbsent` do real work.
function buildReportMarkdown(claims: number, sourceCount: number): string {
  const lines: string[] = ["# Synthetic bench report", "", "## Findings", ""];
  for (let i = 1; i <= claims; i++) {
    const a = ((i * 7) % sourceCount) + 1;
    let b = ((i * 13) % sourceCount) + 1;
    if (b === a) b = (b % sourceCount) + 1;
    const ids = [a, b];
    if (i % 3 === 0) {
      let c = ((i * 29) % sourceCount) + 1;
      while (c === a || c === b) c = (c % sourceCount) + 1;
      ids.push(c);
    }
    const cites = ids.map((id) => `[S${id}]`).join(" ");
    const numeral = i % 4 === 0 ? ` in ${2000 + (i % 25)}` : i % 4 === 1 ? ` by ${i % 100} percent` : "";
    lines.push(`Synthetic claim number ${i} reports a measurable effect on system throughput${numeral} across the evaluated deployments ${cites}.`);
    lines.push("");
  }
  return lines.join("\n");
}

// A big-enough prose page (>=2000 chars, past looksLikeJunkExtraction's short-
// text scrutiny) so every one of the 40 addSources URLs is accepted, not
// rejected as an anti-bot wall / junk extraction.
const ENRICH_PAGE = `<title>Enrich fixture</title><p>${prose(999, 4_000)}</p>`;

// 20 sources whose `url` is a non-citable machine endpoint (matches the exact
// shape tests/relink.test.ts proves autoRelink can repair) and whose extract
// text names a derivable document via a distinct DOI each, so every one
// resolves cleanly with no "duplicate" collisions.
function buildRelinkDossier(dir: string, n: number): void {
  const sources = writeFixtureDossier(dir, n);
  for (let i = 0; i < n; i++) {
    const url = `https://api.test/v1/rec/${i}?format=json`;
    sources[i]!.url = url;
    sources[i]!.canonicalUrl = url;
    sources[i]!.domain = "api.test";
    sources[i]!.title = url;
    writeFileSync(
      join(dir, sources[i]!.extract),
      `# S${i + 1} — endpoint\n- url: x\n- backend: claude\ndoi: 10.1000/bench${i}\n\nA synthetic record naming its own document.\n`,
    );
  }
  writeFileSync(join(dir, "sources.json"), JSON.stringify(sources, null, 2));
}

async function timeAsync<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - t0 };
}
function timeSync<T>(fn: () => T): { result: T; ms: number } {
  const t0 = performance.now();
  const result = fn();
  return { result, ms: performance.now() - t0 };
}

function row(label: string, ms: number, size: string): string {
  return `  ${label.padEnd(28)} ${ms.toFixed(1).padStart(9)} ms   ${size}`;
}

describe.skipIf(!process.env.ULTRASEARCH_BENCH)("offline hot paths — bench", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("times buildWorklist / runCheck / render / addSources / autoRelink / probeServices", { timeout: 120_000 }, async () => {
    const rows: string[] = [];
    const dossierSize = `${SOURCE_COUNT} src / ${CLAIM_COUNT} claims`;

    // --- build the synthetic check/verify/render dossier ---
    const dirCheck = mkdtempSync(join(tmpdir(), "us-bench-check-"));
    dirs.push(dirCheck);
    const manifest = buildManifest();
    const template = getMode(manifest.mode).template;
    writeDossier(dirCheck, buildRawSources(SOURCE_COUNT), manifest, template);
    writeFileSync(join(dirCheck, "REPORT.md"), buildReportMarkdown(CLAIM_COUNT, SOURCE_COUNT));

    // --- addSources: 40 URLs, fetch stubbed ---
    const dirEnrich = mkdtempSync(join(tmpdir(), "us-bench-enrich-"));
    dirs.push(dirEnrich);
    writeFixtureDossier(dirEnrich, 3);
    installFetchMock(() => ({ body: ENRICH_PAGE }));
    const urls = Array.from({ length: ENRICH_URLS }, (_, i) => `https://enrich${i}.bench-offline.example.net/article/${i}`);
    const { result: enrichResult, ms: enrichMs } = await timeAsync(() => addSources(dirEnrich, urls, {}));
    vi.unstubAllGlobals();
    expect(enrichResult.added).toBe(ENRICH_URLS);
    rows.push(row("addSources", enrichMs, `${ENRICH_URLS} urls`));

    // --- buildWorklist: default, then sharded ---
    const { result: worklist, ms: worklistMs } = timeSync(() => buildWorklist(dirCheck));
    expect(worklist.total).toBeGreaterThan(40); // proves the cap actually engaged
    rows.push(row("buildWorklist (default)", worklistMs, dossierSize));

    const { result: shardedWorklist, ms: shardedMs } = timeSync(() => buildWorklist(dirCheck, { shards: 4, shard: 0 }));
    expect(shardedWorklist.kept).toBeLessThan(worklist.kept);
    rows.push(row("buildWorklist (shards:4)", shardedMs, dossierSize));

    // --- runCheck: plain, then --require-verify ---
    const { result: checkResult, ms: checkMs } = timeSync(() => runCheck(dirCheck));
    expect(checkResult.sourceCitations).toBeGreaterThan(0);
    rows.push(row("runCheck", checkMs, dossierSize));

    // Exactly ONE adjudicated verdict — enough for `applySemantic` to get past
    // its early "0 adjudicated" return and reach the `requireVerify` COVERAGE
    // branch (src/check.ts ~192-208), which re-derives `buildWorklist(dir)` and
    // fails on every claim/source pair still missing a verdict. An all-empty
    // verdicts file never reaches that branch at all, so it would measure the
    // same thing as plain `runCheck` — this seeds just enough to force the real
    // hot path (the worklist re-derivation) to run.
    const firstPair = worklist.worklist.pairs[0]!;
    const verdicts: Verdict[] = [{ ...firstPair, verdict: "supported", note: "" }];
    writeFileSync(join(dirCheck, "VERIFY.json"), JSON.stringify({ ...reduceVerdicts(verdicts), verdicts }));
    const { result: verifyCheckResult, ms: verifyCheckMs } = timeSync(() => runCheck(dirCheck, { requireVerify: true }));
    // The other pairs are still uncovered, so the gate fails closed — and the
    // "no verdict in VERIFY.json" message only fires from the coverage branch,
    // proving buildWorklist actually re-ran here.
    expect(verifyCheckResult.ok).toBe(false);
    expect(verifyCheckResult.errors.some((e) => e.includes("no verdict in VERIFY.json"))).toBe(true);
    rows.push(row("runCheck (requireVerify)", verifyCheckMs, dossierSize));

    // --- render: writeHtml + writeReportMarkdown ---
    const { result: htmlPath, ms: htmlMs } = timeSync(() => writeHtml(dirCheck));
    expect(existsSync(htmlPath)).toBe(true);
    rows.push(row("writeHtml", htmlMs, dossierSize));

    const { result: mdPath, ms: mdMs } = timeSync(() => writeReportMarkdown(dirCheck));
    expect(existsSync(mdPath)).toBe(true);
    rows.push(row("writeReportMarkdown", mdMs, dossierSize));

    // --- autoRelink: 20 derivable endpoint sources, its own dossier ---
    const dirRelink = mkdtempSync(join(tmpdir(), "us-bench-relink-"));
    dirs.push(dirRelink);
    buildRelinkDossier(dirRelink, RELINK_SOURCES);
    const { result: relinkResult, ms: relinkMs } = timeSync(() => autoRelink(dirRelink));
    expect(relinkResult.repaired).toHaveLength(RELINK_SOURCES);
    expect(relinkResult.remaining).toEqual([]);
    rows.push(row("autoRelink", relinkMs, `${RELINK_SOURCES} src`));

    // --- probeServices: probes mocked/pinned offline (tests/setup.ts + the
    // runWithInput mock above), so this never touches the network or npx ---
    const { result: services, ms: servicesMs } = await timeAsync(() => probeServices());
    expect(services.length).toBeGreaterThan(0);
    expect(services.find((s) => s.name === "firecrawl")?.ok).toBe(false);
    rows.push(row("probeServices", servicesMs, "n/a"));

    // eslint-disable-next-line no-console
    console.log("\n" + rows.join("\n") + "\n");
  });
});
