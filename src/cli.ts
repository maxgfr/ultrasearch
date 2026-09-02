import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { realpathSync, existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { VERSION, ALL_MODES, ALL_DEPTHS, ALL_BACKENDS, ALL_WEB_ENGINES, ALL_SEARCH_PROFILES, DEPTH_CAPS, DEEP_CAPS } from "./types.js";

// Re-exported for scripts/verify-skill-bundle.mjs, which imports the built
// bundle and cross-checks the documented flag surface against these tables.
export { ALL_WEB_ENGINES, ALL_SEARCH_PROFILES };
import type { BackendKind, Depth, GatherOptions, Manifest, ModeName, SearchProfile, WebEngine } from "./types.js";
import { parseWebResults } from "./backends/websearch.js";
import { runGather, ignoredByExplicitBackends, type GatherResult } from "./gather.js";
import { runBackends } from "./backends/registry.js";
import { getMode, listModes } from "./modes/registry.js";
import { buildSource } from "./dossier.js";
import { addSource, addSources, addFiles, type IngestResult } from "./enrich.js";
import { loadRenderContext, writeHtml, writeReportMarkdown } from "./render.js";
import { runCheck, formatCheckReport } from "./check.js";
import { autoRelink, listIssues, relink } from "./relink.js";
import { runPlan } from "./plan.js";
import { planQueries, formatQueryPlan } from "./queries.js";
import { runBrainstorm } from "./brainstorm.js";
import { runMerge } from "./merge.js";
import { runVerify, applyVerdicts, formatVerifyReport } from "./verify.js";
import { PHASES, emitOrchestration, listPhasesFor } from "./orchestrate.js";
import { type CommandArgs, type ParsedArgs, parseArgs, runStdioServer, startHttpServer, UsageError } from "./engine.js";
import { ultrasearchAdapter } from "./mcp/adapter.js";
import { isNoWrite, setNoWrite, takeArtifacts } from "./no-write.js";
import { probeServices, formatServices, stackControl, describeWebSearchLane } from "./services.js";

export const HELP = `ultrasearch v${VERSION}
Recap everything the web says about a topic — fan out keyless web search,
fetch + dedupe sources into a dossier, and write a citation-checked, tiered
report (with self-contained HTML). The web-facing sibling of ultradoc.

Usage:
  ultrasearch gather --q "<topic/question>" [--mode <m>] [--depth <d>] [options]
  ultrasearch queries --q "<question>" [--mode <m>] [--depth <d>] [--lang <c>] [--json]
  ultrasearch search --backend <kind> --q "<query>" [options]
  ultrasearch fetch  --url <u> --out <dossier-dir> [--q "<question>"] [--title <s>] [--cite-url <page>]
  ultrasearch ingest --run <dossier-dir> [--web-results <f.json|->] [--urls <u,...>] [--files <p,...>] [--json]
  ultrasearch render --run <dossier-dir> [--no-html] [--no-md]
  ultrasearch check  --run <dossier-dir> [--semantic] [--require-verify] [--strict-numerals] [--min-sources <n>]
  ultrasearch relink --run <dossier-dir> [--list] [--id <S#> --url <page>] [--title <s>]
  ultrasearch modes  [--json]
  ultrasearch doctor [--run <dossier-dir>] [--json]
  ultrasearch mcp    [--transport stdio|http] [--run <dossier-dir>] [--port <n>] [--bind <addr>]
                     [--allow-origin <o,...>] [--allow-remote] [--max-response-bytes <n>]
  ultrasearch brainstorm --q "<vague question>" [--mode <m>] [--out <dir>] [--json]
  ultrasearch plan   --q "<question>" [--mode <m>] [--subquestions "a|b|c"] [--run-root <dir>] [--max-subquestions <n>]
  ultrasearch merge  --runs "<dir1,dir2,…>" --master <dir> [--q "<question>"]
  ultrasearch verify --run <dossier-dir> [--apply <files>] [--shards <n> --shard <i>] [--max-verify <n>]
  ultrasearch orchestrate --run <run-dir> [--phase gather|verify] [--eco] [--list]

Commands:
  gather   Fan out the mode's backends, fetch + dedupe, write the evidence
           dossier (sources.json, sources/S#.md, DOSSIER.md, manifest.json).
           You then write SUMMARY/REPORT.md, run render, then check.
  queries  Print the WebSearch worklist: how many DISTINCT queries to run for
           this depth, the mode's angles to cover, and the planner's starting
           points. Run YOUR OWN WebSearch once per angle, pool every hit, and
           feed them to gather --web-results. One query is not a sweep.
  search   Drill ONE backend and print ranked results (writes nothing).
  fetch    Ingest ONE URL into an existing dossier (alias: add-source). Prints
           the new source id (S#).
  ingest   Ingest MANY URLs into an existing dossier in a single process — the
           batch form of 'fetch', and the way to top up a dossier from your own
           WebSearch. Takes --web-results <f.json|-> or --urls <u,...>, and
           reports one outcome per URL (added / already there / refused).
  render   Render the report tiers in a dossier to a self-contained index.html
           AND a consolidated index.md (both by default; --no-html / --no-md skip one).
  check    Validate citation grounding of SUMMARY/REPORT.md (--semantic
           also folds in the verify verdicts: fails on unsupported claims;
           --require-verify makes a missing/empty VERIFY.json a hard failure —
           the deep-tier exit gate; --min-sources <n> fails a too-thin dossier).
  relink   Repair source CITATIONS in place (no re-fetch, no network). Bare, it
           rewrites every source whose own text names where it lives (canonical
           link, DOI, arXiv id, PMID) and then prints what it could not prove.
           --list is the dry run. --id <S#> --url <page> folds in your answer.
  modes    List the report modes and their backend profiles.
  doctor   Report the state of the engine and its optional helpers: the SearXNG
           and Firecrawl containers, the PDF extractor ladder. The helpers are
           skipped in SILENCE when absent, so this is how you find out a
           container is up but unused, or a stronger PDF reader is missing.
           With --run <dossier-dir>, also says whether THAT run had a WebSearch
           lane — a dossier built without one looks just like a good one.
  searxng  | firecrawl   Manage the optional container: up | down | status.
  brainstorm  Probe a vague/ambiguous question with a shallow keyless search and
           propose candidate angles + clarifying questions before a full run
           (writes BRAINSTORM.md / BRAINSTORM.json). Use when the ask is unclear.

Deep research (the agentic tier — see references/deep-research-playbook.md):
  plan     Decompose a question into sub-questions (JSON) for the fan-out:
           run one 'gather' per sub-question, then 'merge'. With --run-root <dir>
           each sub-question carries a deterministic 'out' dir (<dir>/q1…) so you
           can dispatch one gather per sub-question without parsing stdout.
  merge    Union sub-dossiers into one master dossier with stable [S#] ids.
  verify   Emit a claim↔source worklist for adversarial verification, then
           (--apply <files>) gate on refuted/unsupported claims. --shards <n>
           --shard <i> writes shard i only (one skeptic subagent per shard);
           --apply accepts several verdict files (comma list or a directory).
  orchestrate  Emit the run's multi-agent orchestration from its CURRENT
           worklists: one launchable workflow per ready phase (gather fans out
           one gatherer per PLAN.json sub-question; verify fans skeptics over
           VERIFY.todo.json) + the agents/<role>.md dispatch contracts + a
           sequential RUNBOOK.md, under <run>/orchestration/. Subagents return
           fragments; the merge / verify --apply folds stay with you.

Options:
  --q, --question <s>  The topic or question                      (required)
  --mode <m>           ${ALL_MODES.join(" | ")}   (default: topic)
  --depth <d>          ${ALL_DEPTHS.join(" | ")}            (default: standard)
  --backends <list>    Override the mode profile (comma-separated backend kinds)
  --backend <kind>     For 'search': the single backend to drill
  --queries <a|b|c>    Pipe-separated query variants to search with (overrides the
                       built-in planner; kept in dedup order, capped 2/4/6 by depth)
  --max-sources <n>    Opt-in FETCH budget: cap how many discovered candidates
                       get hydrated. UNSET BY DEFAULT — every page discovery
                       finds is fetched, and every page fetched and found
                       on-topic is kept. Set it only to bound a run's cost;
                       whatever it leaves behind is reported, never silent.
  --per-source <n>     Cap results per backend           (default: per depth)
  --lang <code>        Search language (translate --queries to it)  (default: en)
  --region <cc>        Region/country for locale-aware search   (default: from lang)
  --searxng <url>      SearXNG base URL                  (env ULTRASEARCH_SEARXNG)
  --firecrawl <url>    Self-hosted Firecrawl base URL for browser-rendered page
                       extraction; "off" disables it   (env ULTRASEARCH_FIRECRAWL,
                       default http://localhost:3002, skipped when unreachable)
  --web-results <f>    YOUR OWN WebSearch hits, as JSON: [{url,title,snippet}, …]
                       (a bare array of URLs, or '-' for stdin, also work). This
                       is the PRIMARY discovery lane — the strongest index here,
                       and the only one needing neither a container nor a scrape.
  --search <p>         ${ALL_SEARCH_PROFILES.join(" | ")}   how wide discovery casts:
                       light = the WebSearch lane + the mode's API backends
                       full  = also fuse the keyless cascade + SearXNG
                       max   = the ceiling — full + Firecrawl's /search in
                               discovery, every recall knob at its limit, and
                               --depth deep unless you pin one. Wants the whole
                               container stack up and says so when it is not.
                       auto  = light when --web-results is given, else full
  --web-engine <e>     ${ALL_WEB_ENGINES.join(" | ")}
                       auto = resilient fallback cascade        (default: auto)
  --pages <n>          Result pages to fetch per web engine (≤5; default: per depth)
  --web-breadth <n>    Web engines the auto cascade fuses   (≤5; default: per depth)
  --url <u,...>        URLs for the 'generic' backend / 'fetch' / 'relink'
  --urls <u,...>       For 'ingest': the URLs to add (alternative to --web-results)
  --files <p,...>      For 'ingest': local documents to add — PDFs, office files
                       (.docx/.pptx/.xlsx/.odt/…) and plain text. Their contents
                       enter the dossier and any report rendered from it.
  --cite-url <page>    For 'fetch': read the text from --url but CITE this page —
                       when you know the document an endpoint returns
  --id <S#>            For 'relink': the source to repoint
  --title <s>          For 'fetch'/'relink': override the source's title
  --since <date>       Recency hint where a backend supports it
  --exclude-domains <list>  Drop these hosts from results
  --seed-domains <list>     Also run a targeted site: search for these primary
                       hosts and rank them as primary (up to 3, comma-separated)
  --concurrency <n>    In-flight page-fetch concurrency      (default: 6)
  --rounds <n>         Retrieval rounds; 2 adds a gap-driven follow-up web
                       search for under-covered terms          (default: 1)
  --cache              (default; kept as an accepted no-op) Reuse the on-disk
                       fetch cache across runs — 24h TTL, keyed by canonical URL
                       + Accept-Language, successful extractions only
  --no-cache           Disable the on-disk fetch cache: fetch every page live
  --out <dir>          Dossier output dir   (default: /tmp/ultrasearch/<slug>/<id>)
  --run <dir>          For render/check/verify/orchestrate: the run dir to operate on
  --phase <name>       For 'orchestrate': emit one phase only — gather | verify
                       (exit 2 when its worklist does not exist yet)
  --eco                For 'orchestrate': emit only RUNBOOK.md + agents/*.md —
                       the explicit sequential low-token path
  --list               For 'orchestrate': print the phases + readiness as JSON
  --no-html / --no-md  For 'render': skip index.html / the consolidated index.md
  --semantic           For 'check': also gate on the verify verdicts
  --require-verify     For 'check': fail if no adjudicated VERIFY.json (deep gate)
  --strict-numerals    For 'check': fail (not warn) when a cited claim's numeral
                       is absent from every cited source extract
  --min-sources <n>    For 'check': fail a dossier with fewer kept sources
  --stdout             Write NOTHING to disk; stream what would have been written
                       (env ULTRASEARCH_NO_WRITE=1 does the same globally). For a
                       read-only phase. gather → DOSSIER.md + every source
                       extract · brainstorm → BRAINSTORM.md · plan → PLAN.json ·
                       render → index.md (no HTML). merge / fetch / verify /
                       orchestrate exit 2: they exist to leave files behind.
                       No 'check' gate is possible without files — cite carefully.
  --json               Machine-readable output
  -h, --help           Show this help
  -v, --version        Show version

Deep-tier options (plan / merge / verify):
  --subquestions <a|b|c>    plan: override the sub-questions (pipe-separated)
  --max-subquestions <n>    plan: cap the decomposition       (default: ${DEEP_CAPS.maxSubQuestions})
  --run-root <dir>          plan: give each sub-question an out dir under <dir>
  --runs <d1,d2,…>          merge: the sub-dossiers to union
  --master <dir>            merge: the master dossier dir     (default: derived)
  --apply <spec>            verify: verdict file, comma list, or directory
  --shards <n> --shard <i>  verify: write only shard i of the worklist (0-based)
  --max-verify <n>          verify: cap claim↔source pairs    (default: ${DEEP_CAPS.maxVerify})

Grounding:
  'gather' writes the dossier; you write SUMMARY/REPORT.md citing sources
  like [S1], flagging your own knowledge as [M] or '> [model-hint]'. Then:
    ultrasearch render --run <dir>   # → index.html + index.md
    ultrasearch check  --run <dir>   # exit≠0 if a claim is ungrounded
`;

export const COMMANDS = new Set([
  "gather",
  "queries",
  "search",
  "fetch",
  "add-source",
  "ingest",
  "render",
  "check",
  "relink",
  "modes",
  "brainstorm",
  "plan",
  "merge",
  "verify",
  "orchestrate",
  "mcp",
  "doctor",
  "searxng",
  "firecrawl",
]);
export const VALUE_FLAGS = new Set([
  "q",
  "question",
  "mode",
  "depth",
  "backends",
  "backend",
  "queries",
  "max-sources",
  "per-source",
  "concurrency",
  "rounds",
  "pages",
  "web-breadth",
  "out",
  "run",
  "lang",
  "region",
  "searxng",
  "firecrawl",
  "web-engine",
  "web-results",
  "search",
  "urls",
  "files",
  "url",
  "cite-url",
  "id",
  "since",
  "exclude-domains",
  "seed-domains",
  "title",
  "subquestions",
  "runs",
  "master",
  "apply",
  "max-subquestions",
  "max-verify",
  "run-root",
  "shards",
  "shard",
  "min-sources",
  "phase",
  // `mcp` only. The flag sets are global, so these are accepted (and ignored)
  // on every command — the same as --phase and --list already are.
  "transport",
  "port",
  "bind",
  "allow-origin",
  "max-response-bytes",
]);
export const BOOL_FLAGS = new Set([
  "json",
  "stdout",
  "no-html",
  "no-md",
  "semantic",
  "require-verify",
  "strict-numerals",
  "cache",
  "no-cache",
  "eco",
  "list",
  "allow-remote",
]);

function fail(message: string): never {
  process.stderr.write(`ultrasearch: ${message}\n`);
  process.exit(1);
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    fail(`invalid --${name} "${value}" (expected: ${allowed.join(", ")})`);
  }
  return value as T;
}

/**
 * One parsed invocation.
 *
 * Kept as this repo's own name for `CommandArgs` so no call site changed when
 * the parser itself moved into the engine with webindex v1.15.0.
 */
export type Parsed = CommandArgs;

/**
 * Parse this CLI's argv against its own flag tables.
 *
 * The PARSER is the engine's as of v1.15.0 — it was the same validating loop in
 * every skill here, and the one place they had all independently got right was
 * refusing an unknown flag. What stays local is the part that is this tool's:
 * the tables above, and what help and version PRINT.
 *
 * The engine throws UsageError rather than exiting, so the exit code lives here
 * where the rest of this CLI's exit policy already does.
 */
export function parseCli(argv: string[]): Parsed {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv, { commands: COMMANDS, valueFlags: VALUE_FLAGS, boolFlags: BOOL_FLAGS });
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    fail(e.message);
  }
  if (parsed.kind === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (parsed.kind === "version") {
    process.stdout.write(VERSION + "\n");
    process.exit(0);
  }
  return parsed;
}

function parseList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// Resolve the `--apply` spec into a list of verdict files: a comma-separated
// list, or a directory (its `*verdict*.json` files, sorted — which naturally
// excludes VERIFY.todo.*.json / VERIFY.json), or a single file. Exported for tests.
export function resolveApplyPaths(spec: string): string[] {
  if (spec.includes(",")) return parseList(spec).map((x) => resolve(x));
  const abs = resolve(spec);
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    const files = readdirSync(abs)
      .filter((f) => /verdict/i.test(f) && /\.json$/i.test(f))
      .sort()
      .map((f) => resolve(abs, f));
    if (!files.length) fail(`no verdict files (*verdict*.json) in directory ${abs}`);
    return files;
  }
  return [abs];
}

// Pure validation of the verify sharding flags (--shards N --shard I, 0-based).
// Returns the parsed pair or an error message; the CLI turns the message into
// `fail`. Exported so the boundary logic is unit-tested without driving main().
export function parseShardArgs(
  shardsRaw: string | undefined,
  shardRaw: string | undefined,
): { ok: true; shards?: number; shard?: number } | { ok: false; error: string } {
  let shards: number | undefined;
  if (shardsRaw !== undefined) {
    const n = Number(shardsRaw);
    if (!Number.isInteger(n) || n < 1) return { ok: false, error: `invalid --shards "${shardsRaw}" (expected an integer ≥ 1)` };
    shards = n;
  }
  let shard: number | undefined;
  if (shardRaw !== undefined) {
    const n = Number(shardRaw);
    if (!Number.isInteger(n) || n < 0) return { ok: false, error: `invalid --shard "${shardRaw}" (expected an integer ≥ 0)` };
    shard = n;
  }
  if (shards !== undefined && shard === undefined) return { ok: false, error: "--shards requires --shard <i> (0-based)" };
  if (shards === undefined && shard !== undefined) return { ok: false, error: "--shard requires --shards <n>" };
  if (shards !== undefined && shard !== undefined && shard >= shards) {
    return { ok: false, error: `--shard ${shard} is out of range for --shards ${shards} (use 0..${shards - 1})` };
  }
  return { ok: true, shards, shard };
}

// Read the `--web-results` payload: a file path, or "-" for stdin so a
// read-only phase can pipe its hits in without ever touching the disk.
export function readWebResultsPayload(spec: string): string {
  if (spec === "-") {
    try {
      return readFileSync(0, "utf8");
    } catch {
      fail("--web-results -: could not read stdin");
    }
  }
  const abs = resolve(spec);
  if (!existsSync(abs)) fail(`--web-results file not found: ${abs}`);
  try {
    return readFileSync(abs, "utf8");
  } catch (e) {
    fail(`--web-results: could not read ${abs} (${(e as Error).message})`);
  }
}

function parseBackends(s: string): BackendKind[] {
  const out: BackendKind[] = [];
  for (const t of parseList(s)) {
    if (!(ALL_BACKENDS as readonly string[]).includes(t)) {
      fail(`unknown backend "${t}" (use: ${ALL_BACKENDS.join(", ")})`);
    }
    if (!out.includes(t as BackendKind)) out.push(t as BackendKind);
  }
  if (out.length === 0) fail("--backends resolved to nothing");
  return out;
}

// --- no-write (--stdout) ---------------------------------------------------

// Commands whose whole purpose is to leave something on disk for a LATER process
// to read: a master dossier, a new [S#] in an existing one, a worklist skeptic
// subagents open, a workflow script the harness launches BY PATH. Streaming
// those to stdout would produce output nobody can act on, so they refuse instead
// of pretending to work. This is policy, not safety — the gate in no-write.ts
// already guarantees nothing is written either way.
export const NO_WRITE_REFUSED: Record<string, string> = {
  merge: "it unions the sub-dossiers into a master dossier on disk",
  fetch: "it adds a new [S#] to a dossier on disk",
  "add-source": "it adds a new [S#] to a dossier on disk",
  ingest: "it adds new [S#] entries to a dossier on disk",
  relink: "it rewrites a source's url in a dossier on disk",
  verify: "it emits a worklist for skeptics to read from disk (and --apply folds their verdicts back into it)",
  orchestrate: "it emits workflow scripts and agent contracts the harness opens by path",
};

// The brief each command leads with, in the order a reader wants them. Only one
// is ever present per run; the source extracts slot in after it.
const STDOUT_BRIEF = ["DOSSIER.md", "BRAINSTORM.md", "PLAN.json", "index.md"];

function sourceNum(rel: string): number {
  return Number(/^sources\/S(\d+)\.md$/.exec(rel)?.[1] ?? 0);
}

// Stream the artifacts the run would have written. Text form prints a CURATED
// set — sources.json and manifest.json only restate DOSSIER.md for a reading
// agent, at real token cost — while --json carries every artifact losslessly.
//
// The `===== path =====` delimiter is for READING, not parsing: fetched page
// text is untrusted (invariant I2) and could itself contain such a line. --json
// is the form to parse.
function emitArtifacts(dir: string, asJson: boolean, extra: Record<string, unknown> = {}): void {
  const artifacts = takeArtifacts().map((a) => ({ rel: relative(dir, a.path) || basename(a.path), content: a.content }));

  if (asJson) {
    const files: Record<string, string> = {};
    for (const a of artifacts) files[a.rel] = a.content;
    // `dir` is null on purpose: naming a path that was never created is a trap.
    process.stdout.write(JSON.stringify({ dir: null, ...extra, artifacts: files }, null, 2) + "\n");
    return;
  }

  const at = (rel: string) => artifacts.find((a) => a.rel === rel);
  const shown = [
    ...STDOUT_BRIEF.map(at),
    ...artifacts.filter((a) => sourceNum(a.rel) > 0).sort((a, b) => sourceNum(a.rel) - sourceNum(b.rel)),
    at("refs.bib"),
  ].filter((a): a is { rel: string; content: string } => a !== undefined);

  const out = shown.map((a) => `===== ${a.rel} =====\n${a.content.endsWith("\n") ? a.content : a.content + "\n"}`);
  if (out.length) process.stdout.write(out.join(""));
}

function num(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) fail(`invalid --${name} "${raw}"`);
  return Math.floor(n);
}

// Pure report for the gather command: 0 retrieved sources is a FAILED
// acquisition, not a happy path — an agent must never be told to "write the
// tiers" over an unusable dossier. Exit 1 + the bridge protocol instead.
export function gatherReport(r: GatherResult, options: GatherOptions): { lines: string[]; exitCode: 0 | 1 } {
  const used = r.manifest.backendsUsed.join(", ") || "none";
  const head = [
    `ultrasearch: ${r.sources.length} source(s) for "${options.question}"`,
    `  mode:     ${options.mode} · depth: ${options.depth}`,
    `  backends: ${used}`,
    // Never advertise a directory that --stdout deliberately did not create.
    options.stdout ? `  dossier:  --stdout — nothing written; the dossier is on stdout` : `  dossier:  ${r.dir}`,
  ];
  if (r.sources.length === 0) {
    // The recovery order follows the engine hierarchy: the agent's own WebSearch
    // first (strongest index, no infra), the keyless engines second. Telling an
    // agent to re-roll the dice on a scraper before it has tried the tool in its
    // own hand is what made WebSearch a last resort in the first place.
    const noLane = !options.webResults?.length;
    return {
      exitCode: 1,
      lines: [
        ...head,
        `  EMPTY DOSSIER — retrieval returned nothing usable. Do NOT write tiers over this. Recover it:`,
        noLane
          ? `    1. run YOUR OWN WebSearch and feed it back: ultrasearch gather --q "…" --web-results <hits.json>`
          : `    1. widen the lane: more/other WebSearch queries → a bigger --web-results, or --search full to fuse the keyless engines`,
        options.stdout
          ? `    2. or read the pages your WebSearch found directly — \`fetch\`/\`ingest\` need a dossier on disk.`
          : `    2. or pin what you found: ultrasearch ingest --run ${r.dir} --web-results <hits.json>`,
        `    3. stop after two empty attempts — report the gap; NEVER invent sources.`,
      ],
    };
  }
  // Which discovery engines actually produced results — the honest, post-hoc
  // answer to "which keyless backends are up?", at zero extra network cost.
  const fused = r.manifest.enginesFused ?? [];
  // --backends silently voids several flags; say so rather than lose recall quietly.
  const ignored = ignoredByExplicitBackends(options);
  const under = r.manifest.coverage?.under ?? [];
  // Say which lane drove discovery, and say it when there was none: an agent
  // that owns a WebSearch tool and did not use it should learn that from the
  // run, not from re-reading the docs.
  const ws = r.manifest.webSearch;
  const laneLine = ws?.supplied
    ? `  websearch: ${ws.supplied} hit(s) supplied → ${ws.kept} kept${ws.rejected ? ` (${ws.rejected} rejected)` : ""}`
    : `  websearch: none supplied — pass your own hits with --web-results <f.json> for the strongest lane`;
  return {
    exitCode: 0,
    lines: [
      ...head,
      ...(r.manifest.searchProfile ? [`  search:   ${r.manifest.searchProfile}`] : []),
      laneLine,
      ...(fused.length ? [`  engines:  ${fused.join(", ")} (fused)`] : []),
      ...(ignored.length ? [`  IGNORED:  ${ignored.join(", ")} — --backends bypasses the cascade, seed-domain and gap rounds`] : []),
      ...(under.length ? [`  weak:     ${under.slice(0, 6).join(", ")} — enrich these before ${options.stdout ? "answering" : "writing"}`] : []),
      ...(options.stdout
        ? [
            `  next:     the dossier and every source extract are on stdout — answer inline, citing [S#].`,
            `            NO 'check' gate exists without files: never state anything the extracts do not say.`,
          ]
        : [
            `  next:     read ${r.dir}/DOSSIER.md, write SUMMARY/REPORT.md (cite [S#]), then:`,
            `            ultrasearch render --run ${r.dir} && ultrasearch check --run ${r.dir}`,
          ]),
    ],
  };
}

export function buildGatherOptions(p: Parsed, opts: { requireQuestion?: boolean } = {}): GatherOptions {
  const question = p.values.q ?? p.values.question ?? "";
  if (opts.requireQuestion !== false && !question) fail('missing --q "<question>"');
  const mode = oneOf<ModeName>("mode", p.values.mode ?? "topic", ALL_MODES);
  // `--search max` means the ceiling, and the biggest single lever on how much
  // detail comes back is --depth. Raising it here (only when the caller pinned
  // no depth) is the difference between "max retrieval at standard caps" and
  // what someone asking for max actually wants. gatherReport prints the result,
  // so the implication is visible rather than magic.
  const askedMax = p.values.search === "max";
  const depth = oneOf<Depth>("depth", p.values.depth ?? (askedMax ? "deep" : "standard"), ALL_DEPTHS);
  const caps = DEPTH_CAPS[depth];
  const webEngine = oneOf<WebEngine>("web-engine", p.values["web-engine"] ?? "auto", ALL_WEB_ENGINES);
  const search = oneOf<SearchProfile>("search", p.values.search ?? "auto", ALL_SEARCH_PROFILES);

  // The WebSearch lane. Parsing is forgiving (see parseWebResults) but an EMPTY
  // result is a hard failure, not a silent downgrade: the agent believed it had
  // handed over its hits, and letting the run quietly fall back to the keyless
  // engines would hide the one thing it most needs to know.
  const webSpec = p.values["web-results"];
  const parsedWeb = webSpec ? parseWebResults(readWebResultsPayload(webSpec)) : undefined;
  if (parsedWeb) {
    for (const n of parsedWeb.notes) process.stderr.write(`ultrasearch: ${n}\n`);
    if (!parsedWeb.hits.length) {
      fail(`--web-results ${webSpec} yielded no usable hit — expected [{"url":"https://…"}, …] (or a list of URLs).`);
    }
  }

  return {
    question,
    mode,
    depth,
    backends: p.values.backends ? parseBackends(p.values.backends) : undefined,
    queries: p.values.queries
      ? p.values.queries
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    // Unset unless asked for: no default FETCH budget (see GatherOptions).
    maxSources: p.values["max-sources"] ? num("max-sources", p.values["max-sources"], 0) : undefined,
    perSource: num("per-source", p.values["per-source"], caps.perSource),
    lang: p.values.lang ?? "en",
    region: p.values.region,
    searxng: p.values.searxng,
    firecrawl: p.values.firecrawl,
    webEngine,
    search,
    ...(parsedWeb ? { webResults: parsedWeb.hits, webResultsRejected: parsedWeb.rejected } : {}),
    pages: p.values.pages ? Math.min(5, num("pages", p.values.pages, 1)) : undefined,
    webBreadth: p.values["web-breadth"] ? Math.min(5, num("web-breadth", p.values["web-breadth"], 1)) : undefined,
    urls: p.values.url ? parseList(p.values.url) : undefined,
    since: p.values.since,
    excludeDomains: p.values["exclude-domains"] ? parseList(p.values["exclude-domains"]) : [],
    seedDomains: p.values["seed-domains"] ? parseList(p.values["seed-domains"]) : undefined,
    concurrency: p.values.concurrency ? num("concurrency", p.values.concurrency, 6) : undefined,
    rounds: p.values.rounds ? num("rounds", p.values.rounds, 1) : undefined,
    // Default ON: the on-disk cache is a pure win for the deep tier's fan-out,
    // for a re-gather after a failed check, and for the `fetch --url` bridge.
    // `--cache` stays an accepted no-op so every prompt and emitted contract
    // already in the wild keeps working; `--no-cache` is the escape hatch.
    cache: !p.bools.has("no-cache"),
    out: p.values.out ? resolve(p.values.out) : undefined,
    json: p.bools.has("json"),
    // Read from the gate, not the flag, so ULTRASEARCH_NO_WRITE=1 alone still
    // reshapes the guidance. main() calls setNoWrite before this runs.
    stdout: isNoWrite(),
  };
}

// Exported (with an argv default) so tests can drive the whole dispatch surface
// in-process — vitest's V8 coverage only instruments src/** in-process, so a
// spawned bundle would exercise this code without ever counting toward it. The
// invokedAsThisModule() gate below still controls auto-run from the CLI.
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const p = parseCli(argv);
  // Before anything else: every write in src/ consults this. `search`, `modes`
  // and `check` accept --stdout as a no-op (they already write nothing), so a
  // host can append the flag blanket-style — exactly like --cache today.
  // Assigned unconditionally, not just when the flag is present: main() is
  // re-entrant in tests and in-process hosts, and a --stdout run must not leave
  // the gate latched for the next invocation. The env var is ORed in by
  // isNoWrite(), so clearing the flag never overrides it.
  setNoWrite(p.bools.has("stdout"));
  const refused = NO_WRITE_REFUSED[p.command];
  if (refused && isNoWrite()) {
    process.stderr.write(
      `ultrasearch: \`${p.command}\` cannot run without writing — ${refused}.\n` +
        `             Drop --stdout / ULTRASEARCH_NO_WRITE=1, or run it outside the read-only phase.\n`,
    );
    process.exitCode = 2;
    return;
  }

  switch (p.command) {
    case "gather": {
      const options = buildGatherOptions(p);
      // Preflight for `--search max` ONLY. It promises the whole stack, and a
      // deep max run costs 10-20 minutes — learning at the end that the
      // containers were down is learning too late. Only the two container
      // probes run, and they run in parallel — ~2s worst case — and it never
      // aborts: a stack-less max is still a good run, it is just not the one
      // that was asked for.
      if (options.search === "max" && !options.json) {
        const down = (await probeServices({ firecrawl: options.firecrawl, searxng: options.searxng }, ["searxng", "firecrawl"])).filter((s) => !s.ok);
        if (down.length) {
          process.stderr.write(
            `ultrasearch: --search max wants the container stack, and ${down.map((s) => s.name).join(" + ")} ${down.length > 1 ? "are" : "is"} not answering.\n` +
              `             Start it:  ultrasearch firecrawl up\n` +
              `             Continuing without it — the run will say what it lost.\n`,
          );
        }
      }
      const r = await runGather(options);
      const report = gatherReport(r, options);
      if (options.stdout) {
        emitArtifacts(r.dir, options.json, { manifest: r.manifest });
        process.stderr.write(report.lines.join("\n") + "\n");
        process.exitCode = report.exitCode;
        return;
      }
      if (options.json) {
        process.stdout.write(JSON.stringify({ dir: r.dir, manifest: r.manifest }, null, 2) + "\n");
        process.exitCode = report.exitCode;
        return;
      }
      process.stderr.write(report.lines.join("\n") + "\n");
      process.exitCode = report.exitCode;
      return;
    }

    case "search": {
      const backendStr = p.values.backend;
      if (!backendStr) fail("missing --backend <kind>");
      const [backend] = parseBackends(backendStr);
      const options = buildGatherOptions(p);
      const ctx = { question: options.question, mode: getMode(options.mode), options, variants: [options.question] };
      const [res] = await runBackends([backend!], ctx);
      if (!res) return;
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
        return;
      }
      const out: string[] = [`# ${backend} — ${res.items.length} result(s) for "${options.question}"`, ""];
      res.items.forEach((it, i) => {
        const s = buildSource(it, `S${i + 1}`, new Date().toISOString(), options.question);
        out.push(`## [${s.id}] ${s.title}`);
        out.push(`${s.url} · trust: ${s.trust} · score: ${s.score}`);
        if (s.snippet) out.push(s.snippet);
        out.push("");
      });
      for (const n of res.notes) out.push(`> ${n}`);
      process.stdout.write(out.join("\n") + "\n");
      return;
    }

    case "queries": {
      const question = p.values.q ?? p.values.question;
      if (!question) fail('missing --q "<question>"');
      const plan = planQueries({
        question,
        mode: oneOf<ModeName>("mode", p.values.mode ?? "topic", ALL_MODES),
        depth: oneOf<Depth>("depth", p.values.depth ?? "standard", ALL_DEPTHS),
        lang: p.values.lang,
      });
      // Prints only — safe in a read-only phase, which is exactly where an agent
      // wants to know what to search before it commits to a run.
      process.stdout.write(p.bools.has("json") ? JSON.stringify(plan, null, 2) + "\n" : formatQueryPlan(plan));
      return;
    }

    case "modes": {
      const modes = listModes();
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(modes, null, 2) + "\n");
        return;
      }
      const out: string[] = ["ultrasearch modes:", ""];
      for (const m of modes) {
        out.push(`  ${m.name.padEnd(9)} ${m.description}`);
        out.push(`            backends: ${m.backends.join(", ")}${m.deepOnly.length ? ` (+deep: ${m.deepOnly.join(", ")})` : ""}`);
        if (m.extras.length) out.push(`            extras:   ${m.extras.join(", ")}`);
      }
      process.stdout.write(out.join("\n") + "\n");
      return;
    }

    // Which optional helpers are actually live. Exists because every one of them
    // is skipped in silence when absent: without this, a SearXNG container can
    // sit up for weeks, never be queried, and nothing anywhere says so.
    case "doctor": {
      // With --run, report the lane THAT RUN actually had. A dossier built
      // without one looks identical to a dossier built with a bad one, so this
      // is the only place the omission becomes visible after the fact.
      const runDir = p.values.run;
      let manifest: Manifest | undefined;
      if (runDir) {
        const mf = join(resolve(runDir), "manifest.json");
        if (!existsSync(mf)) fail(`no dossier at ${resolve(runDir)} (no manifest.json)`);
        try {
          manifest = JSON.parse(readFileSync(mf, "utf8")) as Manifest;
        } catch (e) {
          fail(`could not read ${mf}: ${(e as Error).message}`);
        }
      }
      const rows = [describeWebSearchLane(manifest), ...(await probeServices({ firecrawl: p.values.firecrawl, searxng: p.values.searxng }))];
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        return;
      }
      const head = runDir ? `ultrasearch ${VERSION} — ${resolve(runDir)}` : `ultrasearch ${VERSION} — the engine, and the optional helpers`;
      process.stdout.write(`${head}\n\n${formatServices(rows)}\n`);
      return;
    }

    case "searxng":
    case "firecrawl": {
      const action = p.positional[0] ?? "status";
      if (action === "status") {
        const rows = await probeServices({ firecrawl: p.values.firecrawl, searxng: p.values.searxng }, [p.command]);
        process.stdout.write(formatServices(rows) + "\n");
        return;
      }
      if (action !== "up" && action !== "down") {
        fail(`${p.command}: unknown action '${action}' (expected up | down | status)`);
      }
      const r = stackControl(p.command, action);
      process.stdout.write(r.message + "\n");
      if (r.code !== 0) process.exit(r.code);
      // `up --wait` returns as soon as the healthchecks pass; report what the
      // engine will actually see, which is the only thing that matters here.
      if (action === "up") {
        const rows = await probeServices({ firecrawl: p.values.firecrawl, searxng: p.values.searxng }, [p.command]);
        process.stdout.write("\n" + formatServices(rows) + "\n");
      }
      return;
    }

    case "brainstorm": {
      const options = buildGatherOptions(p);
      const result = await runBrainstorm(options);
      if (options.stdout) {
        emitArtifacts(result.dir, options.json);
        process.stderr.write(`ultrasearch brainstorm: "${result.question}" — nothing written (--stdout).\n`);
        return;
      }
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        return;
      }
      const out: string[] = [];
      out.push(`ultrasearch brainstorm: "${result.question}"`);
      out.push(result.signals.ambiguous ? `  ⚠ under-specified — ${result.signals.reasons.join(" ")}` : `  ✓ specific enough to research directly`);
      if (result.angles.length) {
        out.push("  candidate angles:");
        for (const a of result.angles) out.push(`    · ${a.label}`);
      }
      if (result.candidateQuestions.length) {
        out.push("  candidate refined questions:");
        for (const c of result.candidateQuestions) out.push(`    · ${c.question}`);
      }
      out.push("  ask the user:");
      for (const q of result.userQuestions) out.push(`    ? ${q}`);
      out.push(`  written: ${resolve(result.dir)}/BRAINSTORM.md`);
      process.stdout.write(out.join("\n") + "\n");
      return;
    }

    case "plan": {
      const options = buildGatherOptions(p);
      const override = p.values.subquestions
        ? p.values.subquestions
            .split("|")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const cap = p.values["max-subquestions"] ? num("max-subquestions", p.values["max-subquestions"], 6) : undefined;
      const runRoot = p.values["run-root"] ? resolve(p.values["run-root"]) : undefined;
      // Persist depth into the plan ONLY when --depth was explicitly given: a
      // bare `plan` stays byte-compatible with pre-field plans, so the gatherer
      // contract's "deep when the plan predates the field" fallback stays alive
      // (an unconditional "standard" stamp would silently downgrade deep-habit runs).
      const depth = p.values.depth !== undefined ? options.depth : undefined;
      const result = runPlan(options.question, options.mode, override, cap, runRoot, depth);
      // `plan` already streams its payload to stdout, so --stdout only has to
      // drop the PLAN.json copy the gate collected — printing it twice helps
      // nobody. The `out` dirs stay in the JSON: they are hints for a later run
      // that CAN write, not claims that anything exists now.
      if (options.stdout) takeArtifacts();
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      const rootHint = runRoot ? ` — each carries an \`out\` dir under ${runRoot} to gather into` : "";
      process.stderr.write(
        `ultrasearch: ${result.subQuestions.length} sub-question(s) for "${options.question}" ` +
          `(mode ${options.mode}) — fan out a gather per sub-question, then \`merge\`${rootHint}.\n`,
      );
      return;
    }

    case "merge": {
      const runs = p.values.runs ? parseList(p.values.runs).map((d) => resolve(d)) : [];
      if (!runs.length) fail('missing --runs "<dir1,dir2,…>"');
      for (const d of runs) if (!existsSync(d)) fail(`run dir not found: ${d}`);
      const mode = p.values.mode ? oneOf<ModeName>("mode", p.values.mode, ALL_MODES) : undefined;
      const result = runMerge({
        runs,
        master: p.values.master ? resolve(p.values.master) : undefined,
        question: p.values.q ?? p.values.question,
        mode,
      });
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify({ dir: result.dir, manifest: result.manifest }, null, 2) + "\n");
        return;
      }
      const lines = [
        `ultrasearch: merged ${runs.length} sub-dossier(s) → ${result.sources.length} source(s)`,
        `  master:   ${result.dir}`,
        `  next:     read ${result.dir}/DOSSIER.md, write SUMMARY/REPORT.md citing the MASTER [S#] ids, then:`,
        `            ultrasearch verify --run ${result.dir} && ultrasearch check --semantic --run ${result.dir}`,
      ];
      process.stderr.write(lines.join("\n") + "\n");
      return;
    }

    case "fetch":
    case "add-source": {
      const dir = p.values.out ?? p.values.run;
      if (!dir) fail("missing --out <dossier-dir>");
      const url = p.values.url;
      if (!url) fail("missing --url <u>");
      const r = await addSource(resolve(dir), url, {
        question: p.values.q ?? p.values.question,
        title: p.values.title,
        citeUrl: p.values["cite-url"],
        firecrawl: p.values.firecrawl,
        cache: !p.bools.has("no-cache"), // same default-on policy as gather
      });
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      } else if (r.added) {
        process.stdout.write(`${r.id}\n`);
        process.stderr.write(`ultrasearch: added ${r.id} ← ${url}\n`);
      } else {
        process.stderr.write(`ultrasearch: ${r.note ?? "not added"}\n`);
        if (r.id) process.stdout.write(`${r.id}\n`);
      }
      if (!r.id) process.exit(1);
      return;
    }

    case "ingest": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const spec = p.values["web-results"];
      const listed = p.values.urls ? parseList(p.values.urls) : [];
      const files = p.values.files ? parseList(p.values.files) : [];
      if (!spec && !listed.length && !files.length) fail("missing --web-results <f.json|->, --urls <u,...> or --files <p,...>");

      const hits: (string | { url: string; title?: string })[] = [...listed];
      if (spec) {
        const parsed = parseWebResults(readWebResultsPayload(spec));
        for (const n of parsed.notes) process.stderr.write(`ultrasearch: ${n}\n`);
        if (!parsed.hits.length && !listed.length && !files.length) {
          fail(`--web-results ${spec} yielded no usable hit — expected [{"url":"https://…"}, …] (or a list of URLs).`);
        }
        hits.push(...parsed.hits);
      }

      const enrichOpts = {
        question: p.values.q ?? p.values.question,
        cache: !p.bools.has("no-cache"),
        firecrawl: p.values.firecrawl,
      };
      // URLs and files share one ingest so an agent can pin a page and the deck
      // it links to in a single call. Sequential for the reason addSources is:
      // both allocate [S#] ids by read-then-write.
      const web = hits.length ? await addSources(resolve(dir), hits, enrichOpts) : undefined;
      const local = files.length ? await addFiles(resolve(dir), files, enrichOpts) : undefined;
      const r: IngestResult = {
        results: [...(web?.results ?? []), ...(local?.results ?? [])],
        added: (web?.added ?? 0) + (local?.added ?? 0),
        skipped: (web?.skipped ?? 0) + (local?.skipped ?? 0),
      };
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      } else {
        // One line per URL, refusals included: an ingest that silently dropped
        // half its input would be worse than one that failed outright.
        for (const o of r.results) {
          process.stdout.write(o.added ? `${o.id}\t${o.url}\n` : `-\t${o.url}\t${o.note ?? "not added"}\n`);
        }
        const what = files.length ? (hits.length ? "input(s)" : "file(s)") : "URL(s)";
        process.stderr.write(`ultrasearch: ingested ${r.added} source(s), skipped ${r.skipped} of ${r.results.length} ${what} → ${resolve(dir)}\n`);
      }
      // Nothing added at all is a failed acquisition, not a quiet success.
      if (!r.added) process.exit(1);
      return;
    }

    case "render": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const rdir = resolve(dir);
      // index.html is a ~100 KB self-contained blob whose entire value is being
      // a file you open in a browser; streaming it into a model's context is
      // waste. So --stdout emits index.md only, and never pays to build the HTML.
      if (isNoWrite()) {
        if (p.bools.has("no-md")) {
          process.stderr.write("ultrasearch render: --stdout --no-md leaves nothing to emit (--stdout never produces HTML).\n");
          process.exitCode = 2;
          return;
        }
        writeReportMarkdown(rdir);
        emitArtifacts(rdir, p.bools.has("json"));
        process.stderr.write("ultrasearch: --stdout — index.md above; index.html skipped (it is only useful as a file).\n");
        return;
      }
      // By default render writes BOTH a self-contained index.html and a portable
      // consolidated index.md. --no-html / --no-md opt out of either.
      const wantHtml = !p.bools.has("no-html");
      const wantMd = !p.bools.has("no-md");
      // One read of the dossier (+ its tiers) feeds both writers — and no read
      // at all when both are opted out, so `--no-html --no-md` stays the no-op
      // it has always been (it must not fail on a directory that is not a
      // dossier: it was never going to read one).
      const ctx = wantHtml || wantMd ? loadRenderContext(rdir) : undefined;
      const written: { html?: string; md?: string } = {};
      if (wantHtml) {
        written.html = writeHtml(ctx!, p.values.out && p.values.run ? resolve(p.values.out) : undefined);
        process.stderr.write(`ultrasearch: wrote ${written.html}\n`);
      }
      if (wantMd) {
        written.md = writeReportMarkdown(ctx!);
        process.stderr.write(`ultrasearch: wrote ${written.md}\n`);
      }
      if (p.bools.has("json")) process.stdout.write(JSON.stringify(written, null, 2) + "\n");
      return;
    }

    case "verify": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const rdir = resolve(dir);
      if (p.values.apply) {
        const result = applyVerdicts(rdir, resolveApplyPaths(p.values.apply));
        if (p.bools.has("json")) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        else process.stdout.write(formatVerifyReport(result) + "\n");
        if (!result.ok) process.exit(1);
        return;
      }
      const maxVerify = p.values["max-verify"] ? num("max-verify", p.values["max-verify"], DEEP_CAPS.maxVerify) : undefined;
      // Optional sharding for parallel skeptics: --shards N --shard I (0-based).
      const sh = parseShardArgs(p.values.shards, p.values.shard);
      if (!sh.ok) fail(sh.error);
      const wl = runVerify(rdir, { maxVerify, shards: sh.shards, shard: sh.shard });
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(wl, null, 2) + "\n");
        return;
      }
      if (sh.shards !== undefined) {
        process.stderr.write(
          `ultrasearch: ${wl.pairs.length} pair(s) (shard ${sh.shard} of ${sh.shards}) → ${rdir}/VERIFY.todo.${sh.shard}.json\n` +
            `  adjudicate each verdict, save as verdicts.${sh.shard}.json, then (once all shards are done):\n` +
            `  ultrasearch verify --apply ${rdir} --run ${rdir}   # a dir picks up every verdicts*.json\n`,
        );
      } else {
        process.stderr.write(
          `ultrasearch: ${wl.pairs.length} claim↔source pair(s) → ${rdir}/VERIFY.todo.json\n` +
            `  adjudicate each verdict, save as verdicts.json, then: ` +
            `ultrasearch verify --apply verdicts.json --run ${rdir}\n`,
        );
      }
      return;
    }

    case "orchestrate": {
      const dir = p.values.run;
      if (!dir) {
        process.stderr.write("ultrasearch orchestrate: --run <dir> is required (the run dir holding the worklists PLAN.json / VERIFY.todo.json).\n");
        process.exit(2);
      }
      // The engine's own absolute path — baked into every emitted artifact so
      // subagents (own cwd, no repo notion) can invoke it. Realpath: the bundle
      // may be reached through a symlinked skill dir.
      const engineAbs = realpathSync(fileURLToPath(import.meta.url));
      if (p.bools.has("list")) {
        if (!existsSync(resolve(dir))) {
          process.stderr.write(`ultrasearch orchestrate: run dir not found: ${resolve(dir)}\n`);
          process.exit(2);
        }
        process.stdout.write(JSON.stringify({ phases: listPhasesFor(dir, engineAbs) }, null, 2) + "\n");
        return;
      }
      const res = emitOrchestration(dir, engineAbs, {
        phase: p.values.phase,
        eco: p.bools.has("eco"),
      });
      if (res.exitCode !== 0) {
        for (const e of res.errors) process.stderr.write(`ultrasearch orchestrate: ${e}\n`);
        process.exit(res.exitCode);
      }
      const lines: string[] = ["ultrasearch orchestrate: generated"];
      for (const w of res.written) lines.push(`  ${w}`);
      const workflows = res.written.filter((w) => w.endsWith(".workflow.mjs"));
      if (workflows.length) {
        lines.push("");
        for (const w of workflows) lines.push(`Launch: Workflow({ scriptPath: ${JSON.stringify(w)} })`);
        lines.push("Then run the fold shown at the end of each workflow yourself (merge / verify --apply) — you stay the sole writer.");
      } else {
        lines.push(`Follow ${join(resolve(dir), "orchestration", "RUNBOOK.md")} sequentially (the eco path).`);
      }
      process.stdout.write(lines.join("\n") + "\n");
      for (const n of res.notices) process.stderr.write(`ultrasearch orchestrate: note — ${n}\n`);
      // Surface the valid phase names once, so a scripted caller can discover them without --help.
      if (p.values.phase === undefined && workflows.length === 0 && !p.bools.has("eco")) {
        process.stderr.write(`ultrasearch orchestrate: no ready phase — phases are ${PHASES.join(", ")} (see --list).\n`);
      }
      return;
    }

    case "mcp": {
      const transport = oneOf("transport", p.values.transport ?? "stdio", ["stdio", "http"]);
      const maxResponseBytes = p.values["max-response-bytes"] ? Number(p.values["max-response-bytes"]) : undefined;
      if (maxResponseBytes !== undefined && (!Number.isFinite(maxResponseBytes) || maxResponseBytes <= 0)) fail("invalid --max-response-bytes");
      const options = {
        // A default dossier makes `run` optional on every tool, for a server
        // dedicated to one piece of research.
        defaultRun: p.values.run,
        maxResponseBytes,
      };

      if (transport === "stdio") {
        // Nothing is written to stdout here: from this point stdout carries
        // JSON-RPC frames only, and runStdioServer guards that.
        await runStdioServer(ultrasearchAdapter(options), options);
        return;
      }

      const port = p.values.port ? Number(p.values.port) : 7339;
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail("invalid --port");
      const allowOrigin = p.values["allow-origin"]
        ? p.values["allow-origin"]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      let running: Awaited<ReturnType<typeof startHttpServer>>;
      try {
        running = await startHttpServer(ultrasearchAdapter(options), {
          ...options,
          port,
          bind: p.values.bind,
          allowOrigin,
          allowRemote: p.bools.has("allow-remote"),
        });
      } catch (e) {
        fail((e as Error).message);
      }
      // stderr, not stdout: an HTTP server's stdout is not a protocol stream,
      // but keeping the two transports identical here means no one has to
      // remember which is which.
      process.stderr.write(`ultrasearch: MCP server listening on ${running.url}\n`);
      process.stderr.write(`  client: claude mcp add --transport http ultrasearch ${running.url}\n`);
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.once(sig, () => {
          void running.close().then(() => process.exit(0));
        });
      }
      // Resolve only when the server stops, so `run()` doesn't return while it
      // is still listening.
      await new Promise<void>((resolve) => running.server.once("close", resolve));
      return;
    }

    case "check": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const minSources = p.values["min-sources"] ? num("min-sources", p.values["min-sources"], 1) : undefined;
      const res = runCheck(resolve(dir), {
        semantic: p.bools.has("semantic"),
        requireVerify: p.bools.has("require-verify"),
        strictNumerals: p.bools.has("strict-numerals"),
        minSources,
      });
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      } else {
        process.stdout.write(formatCheckReport(res, resolve(dir)) + "\n");
      }
      if (!res.ok) process.exit(1);
      return;
    }

    case "relink": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const rdir = resolve(dir);
      // `--list` is the dry run: report, change nothing. Bare `relink --run`
      // repairs what the sources' own text proves, then reports what is left.
      if (p.bools.has("list")) {
        const issues = listIssues(rdir);
        if (p.bools.has("json")) process.stdout.write(JSON.stringify(issues, null, 2) + "\n");
        else if (!issues.length) process.stdout.write("ultrasearch relink: nothing to repair — every source cites a page and reads as a document.\n");
        else for (const i of issues) process.stdout.write(`${i.id}  ${i.reason}  ${i.url}\n    ${i.detail}\n    → ${i.fix}\n`);
        return;
      }
      if (!p.values.id && !p.values.url) {
        const { repaired, remaining } = autoRelink(rdir);
        if (p.bools.has("json")) {
          process.stdout.write(JSON.stringify({ repaired, remaining }, null, 2) + "\n");
          return;
        }
        for (const r of repaired) process.stderr.write(`ultrasearch: ${r.id} now cites ${r.to} (was ${r.from})\n`);
        if (!remaining.length) {
          process.stdout.write(`ultrasearch relink: repaired ${repaired.length} source(s); nothing left to fix.\n`);
          return;
        }
        process.stdout.write(`ultrasearch relink: repaired ${repaired.length}, ${remaining.length} need you:\n`);
        for (const i of remaining) process.stdout.write(`${i.id}  ${i.reason}  ${i.url}\n    ${i.detail}\n    → ${i.fix}\n`);
        return;
      }
      const id = p.values.id;
      const url = p.values.url;
      if (!id) fail("missing --id <S#> (or pass --list)");
      if (!url) fail("missing --url <page>");
      const r = relink(rdir, id, url, { title: p.values.title });
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      } else if (r.relinked) {
        process.stderr.write(`ultrasearch: ${r.id} now cites ${r.to} (was ${r.from})\n`);
      } else {
        process.stderr.write(`ultrasearch: ${r.note ?? "not relinked"}\n`);
      }
      if (!r.relinked) process.exit(1);
      return;
    }
  }
}

// Only run when invoked directly (node scripts/ultrasearch.mjs), not when
// imported by tests. Realpath both sides so a symlinked path (macOS /tmp →
// /private/tmp, a globally-linked skill folder) still matches.
//
// Deliberately NOT the engine's `isInvokedDirectly`, and renamed so the two
// cannot be confused. A genuine homonym: the engine matches argv[1]'s basename
// against the configured brand, which is right for a binary on PATH; this
// compares resolved realpaths against THIS module's own URL, which is what
// keeps a symlinked checkout from auto-running under vitest. Renaming is this
// repo's documented answer to a homonym (see scripts/engine-forks.json).
function invokedAsThisModule(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    if (realpathSync(argv1) === realpathSync(modulePath)) return true;
  } catch {
    /* a path may be virtual — fall through */
  }
  return import.meta.url === pathToFileURL(argv1).href;
}

if (invokedAsThisModule()) {
  main().catch((e) => fail((e as Error).message));
}
