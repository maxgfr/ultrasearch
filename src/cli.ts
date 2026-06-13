import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { VERSION, ALL_MODES, ALL_DEPTHS, ALL_BACKENDS, DEPTH_CAPS } from "./types.js";
import type { BackendKind, Depth, GatherOptions, ModeName, WebEngine } from "./types.js";
import { runGather } from "./gather.js";
import { runBackends } from "./backends/registry.js";
import { getMode, listModes } from "./modes/registry.js";
import { buildSource } from "./dossier.js";
import { addSource } from "./enrich.js";
import { writeHtml } from "./render.js";
import { runCheck, formatCheckReport } from "./check.js";

const HELP = `ultrasearch v${VERSION}
Recap everything the web says about a topic — fan out keyless web search,
fetch + dedupe sources into a dossier, and write a citation-checked, tiered
report (with self-contained HTML). The web-facing sibling of ultradoc.

Usage:
  ultrasearch gather --q "<topic/question>" [--mode <m>] [--depth <d>] [options]
  ultrasearch search --backend <kind> --q "<query>" [options]
  ultrasearch fetch  --url <u> --out <dossier-dir> [--q "<question>"]
  ultrasearch render --run <dossier-dir>
  ultrasearch check  --run <dossier-dir>
  ultrasearch modes  [--json]

Commands:
  gather   Fan out the mode's backends, fetch + dedupe, write the evidence
           dossier (sources.json, sources/S#.md, DOSSIER.md, manifest.json).
           You then write SUMMARY/REPORT/FULL.md, run render, then check.
  search   Drill ONE backend and print ranked results (writes nothing).
  fetch    Ingest a URL into an existing dossier (alias: add-source). Prints the
           new source id (S#). This is the bridge for your own WebSearch hits.
  render   Render the report tiers in a dossier to a self-contained index.html.
  check    Validate citation grounding of SUMMARY/REPORT/FULL.md.
  modes    List the report modes and their backend profiles.

Options:
  --q, --question <s>  The topic or question                      (required)
  --mode <m>           ${ALL_MODES.join(" | ")}   (default: topic)
  --depth <d>          ${ALL_DEPTHS.join(" | ")}            (default: standard)
  --backends <list>    Override the mode profile (comma-separated backend kinds)
  --backend <kind>     For 'search': the single backend to drill
  --max-sources <n>    Cap total sources kept            (default: per depth)
  --per-source <n>     Cap results per backend           (default: per depth)
  --lang <code>        Preferred language                (default: en)
  --searxng <url>      SearXNG base URL                  (env ULTRASEARCH_SEARXNG)
  --web-engine <e>     auto | searxng | ddg | claude     (default: auto)
  --url <u,...>        URLs for the 'generic' backend / 'fetch'
  --since <date>       Recency hint where a backend supports it
  --exclude-domains <list>  Drop these hosts from results
  --out <dir>          Dossier output dir   (default: /tmp/ultrasearch/<slug>/<id>)
  --run <dir>          For render/check: the dossier dir to operate on
  --json               Machine-readable output
  -h, --help           Show this help
  -v, --version        Show version

Grounding:
  'gather' writes the dossier; you write SUMMARY/REPORT/FULL.md citing sources
  like [S1], flagging your own knowledge as [M] or '> [model-hint]'. Then:
    ultrasearch render --run <dir>   # → index.html
    ultrasearch check  --run <dir>   # exit≠0 if a claim is ungrounded
`;

export const COMMANDS = new Set(["gather", "search", "fetch", "add-source", "render", "check", "modes"]);
const VALUE_FLAGS = new Set([
  "q", "question", "mode", "depth", "backends", "backend", "max-sources", "per-source",
  "out", "run", "lang", "searxng", "web-engine", "url", "since", "exclude-domains", "title",
]);
const BOOL_FLAGS = new Set(["json", "fresh", "no-html", "verbose"]);

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
  return s.split(",").map((x) => x.trim()).filter(Boolean);
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

function buildGatherOptions(p: Parsed, opts: { requireQuestion?: boolean } = {}): GatherOptions {
  const question = p.values.q ?? p.values.question ?? "";
  if (opts.requireQuestion !== false && !question) fail('missing --q "<question>"');
  const mode = oneOf<ModeName>("mode", p.values.mode ?? "topic", ALL_MODES);
  const depth = oneOf<Depth>("depth", p.values.depth ?? "standard", ALL_DEPTHS);
  const caps = DEPTH_CAPS[depth];
  const webEngine = oneOf<WebEngine>("web-engine", p.values["web-engine"] ?? "auto", [
    "auto", "searxng", "ddg", "claude",
  ]);
  return {
    question,
    mode,
    depth,
    backends: p.values.backends ? parseBackends(p.values.backends) : undefined,
    maxSources: num("max-sources", p.values["max-sources"], caps.maxSources),
    perSource: num("per-source", p.values["per-source"], caps.perSource),
    lang: p.values.lang ?? "en",
    searxng: p.values.searxng,
    webEngine,
    urls: p.values.url ? parseList(p.values.url) : undefined,
    since: p.values.since,
    excludeDomains: p.values["exclude-domains"] ? parseList(p.values["exclude-domains"]) : [],
    out: p.values.out ? resolve(p.values.out) : undefined,
    json: p.bools.has("json"),
    fresh: p.bools.has("fresh"),
  };
}

async function main(): Promise<void> {
  const p = parseArgs(process.argv.slice(2));

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
        `  next:     read ${r.dir}/DOSSIER.md, write SUMMARY/REPORT/FULL.md (cite [S#]), then:`,
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
      const ctx = { question: options.question, mode: getMode(options.mode), options };
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

    case "fetch":
    case "add-source": {
      const dir = p.values.out ?? p.values.run;
      if (!dir) fail("missing --out <dossier-dir>");
      const url = p.values.url;
      if (!url) fail("missing --url <u>");
      const r = await addSource(resolve(dir), url, {
        question: p.values.q ?? p.values.question,
        title: p.values.title,
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
      const path = writeHtml(resolve(dir), p.values.out && p.values.run ? resolve(p.values.out) : undefined);
      process.stderr.write(`ultrasearch: wrote ${path}\n`);
      if (p.bools.has("json")) process.stdout.write(JSON.stringify({ html: path }, null, 2) + "\n");
      return;
    }

    case "check": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const res = runCheck(resolve(dir));
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
