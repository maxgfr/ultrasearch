import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runBackends } from "../backends/registry.js";
import { runBrainstorm } from "../brainstorm.js";
import { runCheck } from "../check.js";
import { buildSource } from "../dossier.js";
import { addSource, addSources } from "../enrich.js";
import { parseWebResults } from "../backends/websearch.js";
import { runGather } from "../gather.js";
import { runMerge } from "../merge.js";
import { getMode, listModes } from "../modes/registry.js";
import { runPlan } from "../plan.js";
import { autoRelink, listIssues, relink } from "../relink.js";
import { writeHtml, writeReportMarkdown } from "../render.js";
import {
  ALL_BACKENDS,
  ALL_DEPTHS,
  ALL_MODES,
  ALL_SEARCH_PROFILES,
  ALL_WEB_ENGINES,
  DEPTH_CAPS,
  type BackendKind,
  type Depth,
  type GatherOptions,
  type ModeName,
  type SearchProfile,
  type WebEngine,
  type WebSearchHit,
} from "../types.js";
import { runVerify } from "../verify.js";
import { withRunLock } from "../run-lock.js";
import { isNoWrite, takeArtifacts } from "../no-write.js";

// Where a tool name becomes work. Every handler calls the same library
// functions the CLI does — nothing here shells out to `ultrasearch`, and
// nothing here calls cli.ts, whose `fail()` would take the server process down
// with a process.exit on a bad argument.

export interface HandlerDefaults {
  defaultRun?: string;
  allowWrite?: boolean;
}

// Thrown for anything the caller can fix by calling again differently. The
// server turns it into an `isError` tool result, never a JSON-RPC error: the
// tool ran, the request was wrong or the world didn't cooperate.
// Re-exported from the engine: the server distinguishes a tool failure from a
// protocol error by INSTANCE, so both halves must use the same class.
export { ToolError } from "../engine.js";
import { ToolError } from "../engine.js";

export type { ToolOutcome } from "../engine.js";
import type { ToolOutcome } from "../engine.js";

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 8 * 1024 * 1024;

// The MCP default, deliberately not the CLI's. `deep` runs 10-20 minutes, and
// an MCP client that times out mid-gather loses the whole run with nothing on
// disk to resume from. A caller who wants deep can still ask for it — but has
// to mean it.
const DEFAULT_DEPTH: Depth = "standard";

// --------------------------------------------------------------------------
// Argument coercion
// --------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function bool(v: unknown): boolean {
  return v === true || v === "true";
}

function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

function positive(v: unknown, key: string): number | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  if (n <= 0) throw new ToolError(`\`${key}\` must be greater than 0.`);
  return n;
}

function requiredStr(args: Record<string, unknown>, key: string, hint: string): string {
  const v = str(args[key]);
  if (!v) throw new ToolError(`\`${key}\` is required — ${hint}`);
  return v;
}

// One of a fixed set, or a message naming what was allowed. The CLI's `oneOf`
// exits; this throws, so one bad value cannot end a long-lived session.
function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], key: string, fallback: T): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ToolError(`\`${key}\` must be one of: ${allowed.join(", ")} (got "${value}")`);
  }
  return value as T;
}

// The WebSearch lane, as an MCP client supplies it: a structured array rather
// than the CLI's file path. Reuses the CLI's forgiving parser by round-tripping
// through JSON, so both surfaces accept exactly the same shapes and there is
// one place where "what counts as a hit" is decided.
function webResultsArg(v: unknown): { hits: WebSearchHit[]; rejected: number } | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new ToolError("`web_results` must be an array of {url, title, snippet} objects (or of URL strings).");
  if (!v.length) return undefined;
  const parsed = parseWebResults(JSON.stringify(v));
  if (!parsed.hits.length) {
    throw new ToolError('`web_results` held no usable hit — expected [{"url": "https://…"}, …] (or a list of URL strings).');
  }
  return { hits: parsed.hits, rejected: parsed.rejected };
}

function requiredRun(args: Record<string, unknown>, defaults: HandlerDefaults): string {
  const run = str(args.run) ?? defaults.defaultRun;
  if (!run) throw new ToolError("`run` is required: the dossier directory returned by ultrasearch_gather.");
  if (!isAbsolute(run)) throw new ToolError("`run` must be an absolute path.");
  const abs = resolve(run);
  if (!existsSync(join(abs, "manifest.json"))) {
    throw new ToolError(`no dossier at ${abs} — build one first with ultrasearch_gather (it returns the directory to pass here).`);
  }
  return abs;
}

// The MCP counterpart of cli.ts's option builder. Same shape, but it THROWS on
// a bad value where the CLI exits.
function gatherOptions(args: Record<string, unknown>): GatherOptions {
  const backends = strArray(args.backends);
  if (backends) {
    for (const b of backends) {
      if (!(ALL_BACKENDS as readonly string[]).includes(b)) throw new ToolError(`unknown backend "${b}" — one of: ${[...ALL_BACKENDS].join(", ")}`);
    }
  }
  const out = str(args.out);
  if (out !== undefined && !isAbsolute(out)) throw new ToolError("`out` must be an absolute path.");

  const depth = oneOf(str(args.depth), ALL_DEPTHS, "depth", DEFAULT_DEPTH);
  // Fall back to the depth's caps, exactly as cli.ts does. These are not
  // optional in GatherOptions, and passing 0 silently caps the run to nothing:
  // the dossier comes back empty and looks like the web had no answer.
  const caps = DEPTH_CAPS[depth];
  const web = webResultsArg(args.web_results);

  return {
    question: requiredStr(args, "question", "the topic or question to research."),
    mode: oneOf(str(args.mode), ALL_MODES, "mode", "topic" as ModeName),
    depth,
    backends: backends as BackendKind[] | undefined,
    queries: strArray(args.queries),
    maxSources: positive(args.max_sources, "max_sources"),
    perSource: positive(args.per_source, "per_source") ?? caps.perSource,
    lang: str(args.lang) ?? "en",
    region: str(args.region),
    // Pilotable from MCP, at last: these were hardcoded, so a client could not
    // pin an engine, point at a SearXNG, or reach the WebSearch lane at all.
    webEngine: oneOf<WebEngine>(str(args.web_engine), ALL_WEB_ENGINES, "web_engine", "auto"),
    search: oneOf<SearchProfile>(str(args.search), ALL_SEARCH_PROFILES, "search", "auto"),
    ...(web ? { webResults: web.hits, webResultsRejected: web.rejected } : {}),
    searxng: str(args.searxng),
    firecrawl: str(args.firecrawl),
    since: str(args.since),
    excludeDomains: strArray(args.exclude_domains) ?? [],
    seedDomains: strArray(args.seed_domains),
    out,
    json: true,
  };
}

// --------------------------------------------------------------------------
// Dispatch
// --------------------------------------------------------------------------

export async function callTool(name: string, args: Record<string, unknown>, defaults: HandlerDefaults = {}): Promise<ToolOutcome> {
  const result = await dispatch(name, args, defaults);
  return outcome(name, result);
}

// The MCP twin of the CLI's exit-2 refusals (NO_WRITE_REFUSED in src/cli.ts).
// These tools exist to leave something on disk for a LATER call to read, so
// under ULTRASEARCH_NO_WRITE they cannot do their job — and a tool that quietly
// returns a plausible result having changed nothing is worse than one that says
// no. `render` is absent on purpose: it streams index.md instead.
const NO_WRITE_REFUSED_TOOLS: Record<string, string> = {
  ultrasearch_fetch: "it adds a new [S#] to a dossier on disk",
  ultrasearch_ingest: "it adds new [S#] entries to a dossier on disk",
  ultrasearch_merge: "it unions the sub-dossiers into a master dossier on disk",
  ultrasearch_verify: "it emits a worklist for skeptics to read from disk",
};

async function dispatch(name: string, args: Record<string, unknown>, defaults: HandlerDefaults): Promise<unknown> {
  const refused = NO_WRITE_REFUSED_TOOLS[name];
  if (refused && isNoWrite()) {
    throw new ToolError(
      `\`${name}\` cannot run while ULTRASEARCH_NO_WRITE is set — ${refused}. Unset it, or use ultrasearch_gather, which streams its dossier back inline.`,
    );
  }

  switch (name) {
    // These three touch no dossier at all.
    case "ultrasearch_modes":
      return { modes: listModes() };
    case "ultrasearch_search":
      return await handleSearch(args);
    case "ultrasearch_plan":
      return handlePlan(args);

    // A gather creates its dossier, so there is nothing yet to lock against.
    case "ultrasearch_gather":
      return await handleGather(args);
    case "ultrasearch_brainstorm":
      return await handleBrainstorm(args);
    case "ultrasearch_merge":
      return handleMerge(args);

    // Everything below mutates or reads ONE existing dossier, and is
    // serialized against other calls on the same one.
    default: {
      const run = requiredRun(args, defaults);
      return await withRunLock(run, async () => {
        switch (name) {
          case "ultrasearch_fetch":
            return await handleFetch(args, run);
          case "ultrasearch_ingest":
            return await handleIngest(args, run);
          case "ultrasearch_check":
            return handleCheck(args, run);
          case "ultrasearch_relink":
            return handleRelink(args, run);
          case "ultrasearch_verify":
            return handleVerify(args, run);
          case "ultrasearch_render":
            return handleRender(args, run);
          case "ultrasearch_read":
            return handleRead(args, run);
          default:
            // Unreachable: the server rejects an unknown tool before dispatch.
            throw new ToolError(`unknown tool: ${name}`);
        }
      });
    }
  }
}

function outcome(name: string, result: unknown): ToolOutcome {
  return { text: JSON.stringify(result, null, 2) + "\n", artifact: artifactFor(name, result) };
}

// Where an oversized result already exists on disk, so an over-cap refusal can
// point at it instead of just saying no. Under no-write there is no such place —
// returning undefined makes capResponse fall back to its plain refusal, which
// tells the caller to narrow the request (--depth summary, fewer max_sources)
// rather than to open a file that was never created.
function artifactFor(name: string, result: unknown): string | undefined {
  if (isNoWrite()) return undefined;
  if (typeof result !== "object" || result === null) return undefined;
  const r = result as Record<string, unknown>;
  if (name === "ultrasearch_gather" || name === "ultrasearch_merge") return typeof r.dossier_md === "string" ? r.dossier_md : undefined;
  if (name === "ultrasearch_brainstorm") return typeof r.path === "string" ? r.path : undefined;
  return undefined;
}

// --------------------------------------------------------------------------
// Handlers
// --------------------------------------------------------------------------

async function handleSearch(args: Record<string, unknown>): Promise<unknown> {
  const query = requiredStr(args, "query", "the search query.");
  // No default: there is no general "web" backend token — a broad sweep is
  // ultrasearch_gather's job, and inventing a default here would send every
  // caller to one arbitrary engine without telling them.
  const chosen = requiredStr(args, "backend", `which backend to query, one of: ${[...ALL_BACKENDS].join(", ")}`);
  const backend = oneOf(chosen, ALL_BACKENDS, "backend", ALL_BACKENDS[0]!);
  const options = gatherOptions({ ...args, question: query, depth: "summary" });
  const results = await runBackends([backend], { question: query, mode: getMode(options.mode), options, variants: [query] });

  const max = positive(args.max_sources, "max_sources") ?? 10;
  const items = results.flatMap((r) => r.items).slice(0, max);
  const notes = results.flatMap((r) => r.notes);
  return {
    query,
    backend,
    count: items.length,
    // A backend that degraded is information, not a failure: it bounds what
    // the caller may conclude from an empty result.
    ...(notes.length ? { notes } : {}),
    results: items.map((i) => ({ url: i.url, title: i.title, snippet: i.snippet })),
    next: "Nothing was written. To cite any of this, ingest the URL with ultrasearch_fetch into a dossier, or run ultrasearch_gather.",
  };
}

async function handleGather(args: Record<string, unknown>): Promise<unknown> {
  const options = gatherOptions(args);
  const res = await runGather(options);
  const head = {
    question: options.question,
    mode: options.mode,
    depth: options.depth,
    sources: res.sources.length,
    ...(res.manifest.notes?.length ? { notes: res.manifest.notes } : {}),
  };
  // Under no-write there is no dossier to point ultrasearch_read at, so the
  // dossier IS the result: the brief plus every source extract, keyed by the
  // path each would have had.
  if (isNoWrite()) {
    return {
      run: null,
      ...head,
      artifacts: artifactMap(res.dir),
      next: "Nothing was written. Answer from the artifacts above, citing [S#]. ultrasearch_check cannot run without files — the grounding discipline is yours.",
    };
  }
  return {
    run: res.dir,
    dossier_md: join(res.dir, "DOSSIER.md"),
    ...head,
    next: `Read ${join(res.dir, "DOSSIER.md")} with ultrasearch_read, write the report citing [S#], then prove it with ultrasearch_check.`,
  };
}

async function handleBrainstorm(args: Record<string, unknown>): Promise<unknown> {
  const options = gatherOptions(args);
  const res = await runBrainstorm(options);
  if (isNoWrite()) {
    return {
      ...res,
      dir: null,
      artifacts: artifactMap(res.dir),
      next: "Nothing was written. Pick an angle, then run ultrasearch_gather on the sharpened question.",
    };
  }
  return { ...res, next: "Pick an angle, then run ultrasearch_gather on the sharpened question." };
}

// Drain the gate's collected artifacts into {relative path: content}. Empty when
// writes went to disk, so a caller can always read it the same way.
function artifactMap(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const a of takeArtifacts()) files[relative(dir, a.path) || a.path] = a.content;
  return files;
}

function handlePlan(args: Record<string, unknown>): unknown {
  const question = requiredStr(args, "question", "the umbrella question to decompose.");
  const mode = oneOf(str(args.mode), ALL_MODES, "mode", "topic" as ModeName);
  const runRoot = str(args.run_root);
  if (runRoot !== undefined && !isAbsolute(runRoot)) throw new ToolError("`run_root` must be an absolute path.");
  const res = runPlan(question, mode, strArray(args.subquestions), positive(args.max_subquestions, "max_subquestions"), runRoot);
  // The plan itself is the payload; a collected PLAN.json copy would only
  // repeat it. The sub-question `out` dirs stay: they are hints for a later
  // call that can write, not claims that anything exists now.
  if (isNoWrite()) takeArtifacts();
  return {
    ...res,
    next: "Run ultrasearch_gather on each sub-question into its own dir, then ultrasearch_merge them into one dossier before writing anything.",
  };
}

function handleMerge(args: Record<string, unknown>): unknown {
  const runs = strArray(args.runs);
  if (!runs?.length) throw new ToolError("`runs` is required — the sub-dossier directories to union.");
  for (const r of runs) {
    if (!isAbsolute(r)) throw new ToolError(`\`runs\` must contain absolute paths (got "${r}").`);
    if (!existsSync(join(r, "manifest.json"))) throw new ToolError(`no dossier at ${r} — every entry of \`runs\` must be a gathered dossier.`);
  }
  const master = str(args.master);
  if (master !== undefined && !isAbsolute(master)) throw new ToolError("`master` must be an absolute path.");

  const res = runMerge({ runs, master, question: str(args.question), mode: str(args.mode) as ModeName | undefined });
  return {
    run: res.dir,
    dossier_md: join(res.dir, "DOSSIER.md"),
    sources: res.sources.length,
    merged_from: runs.length,
    next: `Write ONE report against ${res.dir}, citing the merged [S#] ids, then prove it with ultrasearch_check.`,
  };
}

async function handleFetch(args: Record<string, unknown>, run: string): Promise<unknown> {
  const url = requiredStr(args, "url", "an absolute http(s) URL to fetch.");
  if (!/^https?:\/\//i.test(url)) throw new ToolError("`url` must be an absolute http(s) URL.");
  const res = await addSource(run, url, { question: str(args.question), title: str(args.title), citeUrl: str(args.cite_url) });
  return { run, url, ...res };
}

async function handleIngest(args: Record<string, unknown>, run: string): Promise<unknown> {
  const web = webResultsArg(args.web_results);
  const listed = strArray(args.urls) ?? [];
  for (const u of listed) {
    if (!/^https?:\/\//i.test(u)) throw new ToolError(`\`urls\` must hold absolute http(s) URLs (got "${u}").`);
  }
  const hits: (string | WebSearchHit)[] = [...listed, ...(web?.hits ?? [])];
  if (!hits.length) throw new ToolError("`web_results` or `urls` is required — the URLs to fold into the dossier.");

  const res = await addSources(run, hits, { question: str(args.question), firecrawl: str(args.firecrawl), cache: true });
  return {
    run,
    ...res,
    ...(web?.rejected ? { rejected: web.rejected } : {}),
    // Say what to do next, and only when there IS something to do: a partial
    // ingest is normal (walls, dead links), and the caller needs to know which
    // URLs never became citable rather than assume all of them did.
    ...(res.skipped
      ? { next: "Some URLs were not added — read each result's `note`. A refused page is not citable; find a primary source that carries the text." }
      : {}),
  };
}

function handleCheck(args: Record<string, unknown>, run: string): unknown {
  const res = runCheck(run, {
    semantic: bool(args.semantic),
    requireVerify: bool(args.require_verify),
    strictNumerals: bool(args.strict_numerals),
    minSources: positive(args.min_sources, "min_sources"),
  });
  // ok:false is a verdict, not a failure: the tool did its job and the report
  // did not pass. Reporting it as an error would tell the model the gate is
  // broken instead of that its report is.
  return { run, ...res };
}

function handleRelink(args: Record<string, unknown>, run: string): unknown {
  const id = str(args.id);
  const url = str(args.url);
  if (bool(args.list)) return { run, issues: listIssues(run) };
  if (id || url) {
    if (!id || !url) throw new ToolError("`id` and `url` go together — pass both to repoint one source, or neither to run the automatic pass.");
    const res = relink(run, id, url, { title: str(args.title) });
    if (!res.relinked) throw new ToolError(res.note ?? `${id} was not relinked.`);
    return { run, ...res };
  }
  const { repaired, remaining } = autoRelink(run);
  return {
    run,
    repaired,
    remaining,
    next: remaining.length
      ? "Each remaining entry carries the reason and what would settle it. Search for the page, then call ultrasearch_relink again with id + url."
      : "Every source cites a page a reader can open.",
  };
}

function handleVerify(args: Record<string, unknown>, run: string): unknown {
  const shards = positive(args.shards, "shards");
  const shard = num(args.shard);
  if (shards !== undefined && shard !== undefined && (shard < 0 || shard >= shards)) {
    throw new ToolError(`\`shard\` must be between 0 and ${shards - 1}.`);
  }
  const res = runVerify(run, { maxVerify: positive(args.max_verify, "max_verify"), shards, shard });
  return {
    ...res,
    run,
    next: "For each pair, read the cited source and judge it supported / partial / refuted / unsupported. Rewrite any claim its source does not carry.",
  };
}

function handleRender(args: Record<string, unknown>, run: string): unknown {
  // index.html's whole value is being a file you open in a browser, so under
  // no-write it is never even built — only the portable index.md comes back.
  if (isNoWrite()) {
    if (bool(args.no_md)) throw new ToolError("`no_md` with ULTRASEARCH_NO_WRITE leaves nothing to render — no HTML is produced in that mode.");
    writeReportMarkdown(run);
    return {
      run,
      written: [],
      artifacts: artifactMap(run),
      next: "Nothing was written; index.md is above. index.html is skipped — it is only useful as a file.",
    };
  }
  const written: string[] = [];
  if (!bool(args.no_html)) written.push(writeHtml(run));
  if (!bool(args.no_md)) written.push(writeReportMarkdown(run));
  if (!written.length) throw new ToolError("both `no_html` and `no_md` were set — there is nothing left to render.");
  return { run, written };
}

function handleRead(args: Record<string, unknown>, run: string): unknown {
  const raw = requiredStr(args, "path", "a path relative to the dossier, or an absolute path inside it.");
  const target = isAbsolute(raw) ? raw : join(run, raw);

  // Containment on the REALPATH: a symlink inside the dossier normalises
  // cleanly as a string and only escapes once the filesystem resolves it.
  // This server can be reached over HTTP.
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    throw new ToolError(`no such file: ${raw}`);
  }
  const root = realpathSync(run);
  if (real !== root && !real.startsWith(root + sep)) {
    throw new ToolError(`path is outside the dossier: ${raw}. Use your own file tool for anything else.`);
  }

  const st = statSync(real);
  if (!st.isFile()) throw new ToolError(`not a file: ${raw}`);
  if (st.size > MAX_READ_BYTES) throw new ToolError(`file is too large to read (${st.size} bytes): ${raw}`);

  const lines = readFileSync(real, "utf8").split("\n");
  const total = lines.length;
  const start = Math.max(1, Math.floor(num(args.start_line) ?? 1));
  if (start > total) throw new ToolError(`start_line ${start} is past the end of the file (${total} lines).`);
  const requestedEnd = Math.floor(num(args.end_line) ?? total);
  const end = Math.min(total, Math.max(start, requestedEnd), start + MAX_READ_LINES - 1);

  return {
    path: isAbsolute(raw) ? real : raw,
    start_line: start,
    end_line: end,
    total_lines: total,
    truncated: end < Math.min(total, requestedEnd),
    content: lines.slice(start - 1, end).join("\n"),
  };
}

// Kept for the dossier helper the CLI shares; re-exported so a consumer that
// imports only handlers still reaches it.
export { buildSource };
