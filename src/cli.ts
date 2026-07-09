import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { realpathSync, existsSync, statSync, readdirSync } from "node:fs";
import { VERSION, ALL_MODES, ALL_DEPTHS, ALL_BACKENDS, ALL_WEB_ENGINES, DEPTH_CAPS, DEEP_CAPS } from "./types.js";

// Re-exported for scripts/verify-skill-bundle.mjs, which imports the built
// bundle and cross-checks the documented flag surface against these tables.
export { ALL_WEB_ENGINES };
import type { BackendKind, Depth, GatherOptions, ModeName, WebEngine } from "./types.js";
import { runGather } from "./gather.js";
import { runBackends } from "./backends/registry.js";
import { getMode, listModes } from "./modes/registry.js";
import { buildSource } from "./dossier.js";
import { addSource } from "./enrich.js";
import { writeHtml, writeReportMarkdown } from "./render.js";
import { runCheck, formatCheckReport } from "./check.js";
import { runPlan } from "./plan.js";
import { runBrainstorm } from "./brainstorm.js";
import { runMerge } from "./merge.js";
import { runVerify, applyVerdicts, formatVerifyReport } from "./verify.js";
import { PHASES, listPhases, orchestrateRun } from "./orchestrate.js";

export const HELP = `ultrasearch v${VERSION}
Recap everything the web says about a topic — fan out keyless web search,
fetch + dedupe sources into a dossier, and write a citation-checked, tiered
report (with self-contained HTML). The web-facing sibling of ultradoc.

Usage:
  ultrasearch gather --q "<topic/question>" [--mode <m>] [--depth <d>] [options]
  ultrasearch search --backend <kind> --q "<query>" [options]
  ultrasearch fetch  --url <u> --out <dossier-dir> [--q "<question>"] [--title <s>]
  ultrasearch render --run <dossier-dir> [--no-html] [--no-md]
  ultrasearch check  --run <dossier-dir> [--semantic] [--require-verify] [--strict-numerals] [--min-sources <n>]
  ultrasearch modes  [--json]
  ultrasearch brainstorm --q "<vague question>" [--mode <m>] [--out <dir>] [--json]
  ultrasearch plan   --q "<question>" [--mode <m>] [--subquestions "a|b|c"] [--run-root <dir>] [--max-subquestions <n>]
  ultrasearch merge  --runs "<dir1,dir2,…>" --master <dir> [--q "<question>"]
  ultrasearch verify --run <dossier-dir> [--apply <files>] [--shards <n> --shard <i>] [--max-verify <n>]
  ultrasearch orchestrate --run <run-dir> [--phase gather|verify] [--eco] [--list]

Commands:
  gather   Fan out the mode's backends, fetch + dedupe, write the evidence
           dossier (sources.json, sources/S#.md, DOSSIER.md, manifest.json).
           You then write SUMMARY/REPORT.md, run render, then check.
  search   Drill ONE backend and print ranked results (writes nothing).
  fetch    Ingest a URL into an existing dossier (alias: add-source). Prints the
           new source id (S#). This is the bridge for your own WebSearch hits.
  render   Render the report tiers in a dossier to a self-contained index.html
           AND a consolidated index.md (both by default; --no-html / --no-md skip one).
  check    Validate citation grounding of SUMMARY/REPORT.md (--semantic
           also folds in the verify verdicts: fails on unsupported claims;
           --require-verify makes a missing/empty VERIFY.json a hard failure —
           the deep-tier exit gate; --min-sources <n> fails a too-thin dossier).
  modes    List the report modes and their backend profiles.
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
  --max-sources <n>    Cap total sources kept            (default: per depth)
  --per-source <n>     Cap results per backend           (default: per depth)
  --lang <code>        Search language (translate --queries to it)  (default: en)
  --region <cc>        Region/country for locale-aware search   (default: from lang)
  --searxng <url>      SearXNG base URL                  (env ULTRASEARCH_SEARXNG)
  --web-engine <e>     ${ALL_WEB_ENGINES.join(" | ")}
                       auto = resilient fallback cascade        (default: auto)
  --pages <n>          Result pages to fetch per web engine (≤5; default: per depth)
  --web-breadth <n>    Web engines the auto cascade fuses   (≤5; default: per depth)
  --url <u,...>        URLs for the 'generic' backend / 'fetch'
  --title <s>          For 'fetch': override the ingested page's title
  --since <date>       Recency hint where a backend supports it
  --exclude-domains <list>  Drop these hosts from results
  --seed-domains <list>     Also run a targeted site: search for these primary
                       hosts and rank them as primary (up to 3, comma-separated)
  --concurrency <n>    In-flight page-fetch concurrency      (default: 6)
  --rounds <n>         Retrieval rounds; 2 adds a gap-driven follow-up web
                       search for under-covered terms          (default: 1)
  --cache              Reuse an on-disk fetch cache across runs (24h TTL); the
                       big win is the deep tier's per-sub-question fan-out
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
  "search",
  "fetch",
  "add-source",
  "render",
  "check",
  "modes",
  "brainstorm",
  "plan",
  "merge",
  "verify",
  "orchestrate",
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
  "web-engine",
  "url",
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
]);
export const BOOL_FLAGS = new Set(["json", "no-html", "no-md", "semantic", "require-verify", "strict-numerals", "cache", "eco", "list"]);

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

export interface Parsed {
  command: string;
  positional: string[];
  values: Record<string, string>;
  bools: Set<string>;
}

export function parseArgs(argv: string[]): Parsed {
  if (argv.length === 0) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (argv[0] === "-v" || argv[0] === "--version") {
    process.stdout.write(VERSION + "\n");
    process.exit(0);
  }

  const command = argv[0]!;
  if (!COMMANDS.has(command)) {
    fail(`unknown command: ${command} (run --help for usage)`);
  }

  const values: Record<string, string> = {};
  const bools = new Set<string>();
  const positional: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    }
    if (arg === "-v" || arg === "--version") {
      process.stdout.write(VERSION + "\n");
      process.exit(0);
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq !== -1 ? arg.slice(2, eq) : arg.slice(2);
      if (BOOL_FLAGS.has(key)) {
        if (eq !== -1) fail(`--${key} is a boolean flag and does not take a value`);
        bools.add(key);
        continue;
      }
      if (!VALUE_FLAGS.has(key)) {
        fail(`unknown flag: --${key} (run --help for the supported options)`);
      }
      let value: string;
      if (eq !== -1) {
        value = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          fail(`missing value for --${key}`);
        }
        value = next;
        i++;
      }
      values[key] = value;
      continue;
    }
    positional.push(arg);
  }
  return { command, positional, values, bools };
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

function num(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) fail(`invalid --${name} "${raw}"`);
  return Math.floor(n);
}

export function buildGatherOptions(p: Parsed, opts: { requireQuestion?: boolean } = {}): GatherOptions {
  const question = p.values.q ?? p.values.question ?? "";
  if (opts.requireQuestion !== false && !question) fail('missing --q "<question>"');
  const mode = oneOf<ModeName>("mode", p.values.mode ?? "topic", ALL_MODES);
  const depth = oneOf<Depth>("depth", p.values.depth ?? "standard", ALL_DEPTHS);
  const caps = DEPTH_CAPS[depth];
  const webEngine = oneOf<WebEngine>("web-engine", p.values["web-engine"] ?? "auto", ALL_WEB_ENGINES);
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
    maxSources: num("max-sources", p.values["max-sources"], caps.maxSources),
    perSource: num("per-source", p.values["per-source"], caps.perSource),
    lang: p.values.lang ?? "en",
    region: p.values.region,
    searxng: p.values.searxng,
    webEngine,
    pages: p.values.pages ? Math.min(5, num("pages", p.values.pages, 1)) : undefined,
    webBreadth: p.values["web-breadth"] ? Math.min(5, num("web-breadth", p.values["web-breadth"], 1)) : undefined,
    urls: p.values.url ? parseList(p.values.url) : undefined,
    since: p.values.since,
    excludeDomains: p.values["exclude-domains"] ? parseList(p.values["exclude-domains"]) : [],
    seedDomains: p.values["seed-domains"] ? parseList(p.values["seed-domains"]) : undefined,
    concurrency: p.values.concurrency ? num("concurrency", p.values.concurrency, 6) : undefined,
    rounds: p.values.rounds ? num("rounds", p.values.rounds, 1) : undefined,
    cache: p.bools.has("cache"),
    out: p.values.out ? resolve(p.values.out) : undefined,
    json: p.bools.has("json"),
  };
}

// Exported (with an argv default) so tests can drive the whole dispatch surface
// in-process — vitest's V8 coverage only instruments src/** in-process, so a
// spawned bundle would exercise this code without ever counting toward it. The
// isInvokedDirectly() gate below still controls auto-run from the CLI.
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const p = parseArgs(argv);

  switch (p.command) {
    case "gather": {
      const options = buildGatherOptions(p);
      const r = await runGather(options);
      if (options.json) {
        process.stdout.write(JSON.stringify({ dir: r.dir, manifest: r.manifest }, null, 2) + "\n");
        return;
      }
      const used = r.manifest.backendsUsed.join(", ") || "none";
      const lines = [
        `ultrasearch: ${r.sources.length} source(s) for "${options.question}"`,
        `  mode:     ${options.mode} · depth: ${options.depth}`,
        `  backends: ${used}`,
        `  dossier:  ${r.dir}`,
        `  next:     read ${r.dir}/DOSSIER.md, write SUMMARY/REPORT.md (cite [S#]), then:`,
        `            ultrasearch render --run ${r.dir} && ultrasearch check --run ${r.dir}`,
      ];
      process.stderr.write(lines.join("\n") + "\n");
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

    case "brainstorm": {
      const options = buildGatherOptions(p);
      const result = await runBrainstorm(options);
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
      const result = runPlan(options.question, options.mode, override, cap, runRoot, options.depth);
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
        cache: p.bools.has("cache"),
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

    case "render": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const rdir = resolve(dir);
      // By default render writes BOTH a self-contained index.html and a portable
      // consolidated index.md. --no-html / --no-md opt out of either.
      const written: { html?: string; md?: string } = {};
      if (!p.bools.has("no-html")) {
        written.html = writeHtml(rdir, p.values.out && p.values.run ? resolve(p.values.out) : undefined);
        process.stderr.write(`ultrasearch: wrote ${written.html}\n`);
      }
      if (!p.bools.has("no-md")) {
        written.md = writeReportMarkdown(rdir);
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
        process.stdout.write(JSON.stringify({ phases: listPhases(dir, engineAbs) }, null, 2) + "\n");
        return;
      }
      const res = orchestrateRun(dir, engineAbs, {
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
  }
}

// Only run when invoked directly (node scripts/ultrasearch.mjs), not when
// imported by tests. Realpath both sides so a symlinked path (macOS /tmp →
// /private/tmp, a globally-linked skill folder) still matches.
function isInvokedDirectly(): boolean {
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

if (isInvokedDirectly()) {
  main().catch((e) => fail((e as Error).message));
}
