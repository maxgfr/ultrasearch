import { ALL_BACKENDS, ALL_DEPTHS, ALL_MODES, ALL_SEARCH_PROFILES, ALL_WEB_ENGINES } from "../types.js";
import { ANNOTATIONS_SINCE, RICH_TOOLS_SINCE, type JsonSchema, type JsonSchemaProp, type ProtocolVersion } from "../engine.js";
import { isNoWrite } from "../no-write.js";

// What the server advertises. Pure data — nothing here imports the retrieval
// pipeline, so the declarations can be asserted in a test without reaching the
// network. handlers.ts is where these names become work.

export type { ToolDecl } from "../engine.js";
import type { ToolDecl } from "../engine.js";

// Every spelling the engine accepts, so a model that writes a valid token is
// never rejected by schema validation for something the engine understood.
const MODE_ENUM = [...ALL_MODES].sort();
const DEPTH_ENUM = [...ALL_DEPTHS].sort();
const BACKEND_ENUM = [...ALL_BACKENDS].sort();

const runProp: JsonSchemaProp = { type: "string", description: "The dossier directory returned by ultrasearch_gather." };
const questionProp: JsonSchemaProp = { type: "string", description: "The topic or question, in natural language." };
const modeProp: JsonSchemaProp = {
  type: "string",
  enum: MODE_ENUM,
  description:
    "Which research profile to use: topic (general), bug (an error — StackOverflow/GitHub/HN), research (scholarly APIs + BibTeX), learn (a lesson), startup (market and competitors). Default: topic.",
};
const langProp: JsonSchemaProp = { type: "string", description: "Search language, e.g. 'fr'. Default: en." };

// The WebSearch lane, as an MCP client sees it: structured args, not a file
// path. A client passes values, so the payload comes inline here where the CLI
// takes `--web-results <file>`.
const webResultsProp: JsonSchemaProp = {
  type: "array",
  items: { type: "object" },
  description:
    "YOUR OWN web-search hits — [{url, title, snippet}, …]. This is the PRIMARY discovery lane: the strongest index available here, and the only one that " +
    "needs neither a container nor a scrape. Run your web search first, pass the hits, and the engine fetches, ranks and dedupes them like any other candidate. " +
    "A bare list of URL strings works too.",
};
const searchProfileProp: JsonSchemaProp = {
  type: "string",
  enum: [...ALL_SEARCH_PROFILES].sort(),
  description:
    "How wide discovery casts: 'light' = your web_results lane + the mode's API backends (no scraped cascade, no SearXNG); 'full' = also fuse the keyless " +
    "engines and SearXNG; 'auto' (default) = light when web_results is given, full when it is not.",
};
const webEngineProp: JsonSchemaProp = {
  type: "string",
  enum: [...ALL_WEB_ENGINES].sort(),
  description:
    "Pin the keyless discovery engine instead of running the fallback cascade. 'auto' (default) cascades; 'claude' means your web_results lane IS the discovery.",
};
const searxngProp: JsonSchemaProp = { type: "string", description: "SearXNG base URL (optional self-hosted container; auto-detected on localhost:8888)." };
const firecrawlProp: JsonSchemaProp = {
  type: "string",
  description:
    "Self-hosted Firecrawl base URL for browser-rendered extraction; 'off' disables it. Auto-detected on localhost:3002. Extraction only — it does not discover.",
};

// The line every retrieval tool carries. The whole point of this skill is that
// the answer comes from fetched pages, and a model that treats a dossier as
// optional has already lost the property it was reaching for.
const GROUNDING_NOTE = "Returns SOURCES, not an answer — you write the report from them, citing [S#], and prove it with ultrasearch_check.";

export const TOOLS: ToolDecl[] = [
  {
    name: "ultrasearch_search",
    title: "Search one backend, write nothing",
    description:
      "Run one query against ONE search backend and get ranked results back. Writes nothing and keeps no dossier — this is the cheap lookup for a single " +
      "fact, or a probe to see what a backend knows before committing to a full gather. For anything you intend to cite, use ultrasearch_gather.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        backend: {
          type: "string",
          enum: BACKEND_ENUM,
          description:
            "Which backend to query. There is no default: a general web sweep is what ultrasearch_gather does, and picking one here is the point of this tool. " +
            "Use stackexchange/github/hackernews for a bug, arxiv/openalex/pubmed/crossref for research, wikipedia for a definition, duckduckgo/mojeek/marginalia for the open web.",
        },
        lang: langProp,
        max_sources: { type: "number", description: "Cap on results returned (default 10)." },
      },
      required: ["query", "backend"],
    },
  },
  {
    name: "ultrasearch_gather",
    title: "Build a cited dossier from the web",
    description:
      "Fetch and dedupe pages into a dossier on disk: sources.json, one file per source, DOSSIER.md and manifest.json. Returns the dossier directory. " +
      "PASS YOUR OWN WEB-SEARCH HITS as `web_results` — that lane is the primary engine, and the keyless backends behind it are best-effort fallbacks. " +
      "SLOW and network-bound: depth 'summary' is about 30s, 'standard' 2-4 minutes, 'deep' 10-20 minutes — 'standard' is the default here because a client " +
      "that times out mid-gather loses the run. " +
      GROUNDING_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        question: questionProp,
        web_results: webResultsProp,
        search: searchProfileProp,
        mode: modeProp,
        depth: {
          type: "string",
          enum: DEPTH_ENUM,
          description: "How hard to look: summary (~30s, ≤10 sources), standard (2-4 min, ≤25), deep (10-20 min, ≤60). Default: standard.",
        },
        backends: { type: "array", items: { type: "string" }, enum: BACKEND_ENUM, description: "Override the mode's backend profile." },
        queries: { type: "array", items: { type: "string" }, description: "Your own query variants, instead of the planner's." },
        max_sources: { type: "number", description: "Cap on sources kept (default: per depth)." },
        per_source: { type: "number", description: "Max excerpts kept per source (default: per depth)." },
        lang: langProp,
        region: { type: "string", description: "Region/country for locale-aware search (else derived from lang)." },
        since: { type: "string", description: "Recency filter, where the backend supports it (e.g. 2024)." },
        seed_domains: { type: "array", items: { type: "string" }, description: "Primary hosts to also search with site: and rank as primary." },
        exclude_domains: { type: "array", items: { type: "string" }, description: "Hosts to drop from results." },
        web_engine: webEngineProp,
        searxng: searxngProp,
        firecrawl: firecrawlProp,
        out: { type: "string", description: "Absolute directory to write the dossier to (default: a timestamped dir under the temp root)." },
      },
      required: ["question"],
    },
  },
  {
    name: "ultrasearch_ingest",
    title: "Ingest many URLs into a dossier at once",
    description:
      "The batch form of ultrasearch_fetch: fold a whole set of your own web-search hits into an existing dossier in one call, each becoming a citable [S#]. " +
      "Use this instead of calling ultrasearch_fetch once per URL. Every URL comes back with an outcome — added, already present, or refused with the reason.",
    inputSchema: {
      type: "object",
      properties: {
        run: runProp,
        web_results: webResultsProp,
        urls: { type: "array", items: { type: "string" }, description: "Plain list of absolute http(s) URLs (alternative to web_results)." },
        question: { type: "string", description: "What you're looking for on these pages — ranks the excerpts kept. Defaults to the dossier's question." },
        firecrawl: firecrawlProp,
      },
      required: ["run"],
    },
  },
  {
    name: "ultrasearch_fetch",
    title: "Ingest one URL into a dossier",
    description:
      "Fetch a specific URL, extract and rank its text, and add it to an existing dossier as a new [S#] you can cite. This is how you fold in a page you " +
      "found yourself — including via your own web search — so that it becomes citable evidence rather than an uncited assertion.",
    inputSchema: {
      type: "object",
      properties: {
        run: runProp,
        url: { type: "string", description: "Absolute http(s) URL to fetch." },
        question: { type: "string", description: "What you're looking for on the page — ranks the excerpts kept. Defaults to the dossier's question." },
        title: { type: "string", description: "Override the extracted title." },
        cite_url: {
          type: "string",
          description: "Read the text from `url` but record THIS page as the citation. For when `url` is an API endpoint whose document you already know.",
        },
      },
      required: ["run", "url"],
    },
  },
  {
    name: "ultrasearch_check",
    title: "Validate a report's citations",
    description:
      "The grounding gate. Prove every [S#] in your report resolves to a real source in the dossier, and that enough of the prose is cited at all. A result " +
      "with ok:false is a real verdict, not a tool failure — read the errors, fix the report, and check again.",
    inputSchema: {
      type: "object",
      properties: {
        run: runProp,
        semantic: { type: "boolean", description: "Also fold in recorded verify verdicts, failing on a refuted or unsupported claim." },
        require_verify: { type: "boolean", description: "Fail when no verdicts have been recorded yet." },
        strict_numerals: { type: "boolean", description: "Every number in the prose must appear in a cited source." },
        min_sources: { type: "number", description: "Fail when the dossier holds fewer on-topic sources than this." },
      },
      required: ["run"],
    },
  },
  {
    name: "ultrasearch_relink",
    title: "Repair source citations in a dossier",
    description:
      "Fix sources that cite something a reader cannot open — a machine endpoint rather than the document's page — and list the ones only you can settle. " +
      "Called bare it repairs every source whose stored text names its own document (no network); pass id + url to point one at a page you found.",
    inputSchema: {
      type: "object",
      properties: {
        run: runProp,
        list: { type: "boolean", description: "Dry run: report what needs repair and change nothing." },
        id: { type: "string", description: 'The source to repoint, e.g. "S12". Requires url.' },
        url: { type: "string", description: "The page that source should cite. Requires id." },
        title: { type: "string", description: "Override the repaired source's title." },
      },
      required: ["run"],
    },
  },
  {
    name: "ultrasearch_verify",
    title: "Build a claim-support worklist",
    description:
      "Go past 'the citation resolves' to 'the source actually supports the claim'. Emits a deterministic claim-by-source worklist from the dossier and its " +
      "report, for you to adjudicate each pair as supported / partial / refuted / unsupported.",
    inputSchema: {
      type: "object",
      properties: {
        run: runProp,
        max_verify: { type: "number", description: "Cap on the number of claim/source pairs emitted." },
        shards: { type: "number", description: "Split the worklist into this many shards, to adjudicate in parallel." },
        shard: { type: "number", description: "Which shard to emit, 0-based." },
      },
      required: ["run"],
    },
  },
  {
    name: "ultrasearch_render",
    title: "Render the dossier to HTML and Markdown",
    description:
      "Turn a dossier plus the report you wrote into a self-contained index.html and index.md, with citations linked to their sources. Run it after " +
      "ultrasearch_check passes — rendering an unvalidated report just makes an ungrounded document look finished.",
    inputSchema: {
      type: "object",
      properties: { run: runProp, no_html: { type: "boolean", description: "Skip index.html." }, no_md: { type: "boolean", description: "Skip index.md." } },
      required: ["run"],
    },
  },
  {
    name: "ultrasearch_plan",
    title: "Decompose a question into sub-questions",
    description:
      "Split a broad question into independent sub-questions, each with its own deterministic dossier directory. This is the front half of deep research: " +
      "gather each sub-question separately, then ultrasearch_merge them into one dossier with stable [S#] ids.",
    inputSchema: {
      type: "object",
      properties: {
        question: questionProp,
        mode: modeProp,
        subquestions: { type: "array", items: { type: "string" }, description: "Your own sub-questions, instead of the planner's." },
        max_subquestions: { type: "number", description: "Cap on how many are emitted." },
        run_root: { type: "string", description: "Absolute directory to root the per-sub-question dossier paths at." },
      },
      required: ["question"],
    },
  },
  {
    name: "ultrasearch_merge",
    title: "Merge sub-dossiers into one",
    description:
      "Union several dossiers into a master one, re-assigning [S#] ids so they stay stable and unique across the merge. The back half of deep research: " +
      "you write ONE report against the merged dossier, not one per sub-question.",
    inputSchema: {
      type: "object",
      properties: {
        runs: { type: "array", items: { type: "string" }, description: "The sub-dossier directories to union." },
        master: { type: "string", description: "Absolute output directory (default: derived from mode and question)." },
        question: { type: "string", description: "The original umbrella question." },
        mode: modeProp,
      },
      required: ["runs"],
    },
  },
  {
    name: "ultrasearch_brainstorm",
    title: "Probe a vague question before researching it",
    description:
      "Turn a question too vague to research into angles worth taking and the clarifying questions worth asking first. Use it when the ask is broad enough " +
      "that a gather would return a shallow dossier about the wrong thing.",
    inputSchema: {
      type: "object",
      properties: { question: questionProp, mode: modeProp, out: { type: "string", description: "Absolute directory to write BRAINSTORM.md to." } },
      required: ["question"],
    },
  },
  {
    name: "ultrasearch_modes",
    title: "List the research modes",
    description: "What each mode is for and which backends it searches. Read this when unsure which mode a question belongs to. Writes nothing.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "ultrasearch_read",
    title: "Read a file from a dossier",
    description:
      "Read a file, or a line range of one, from a dossier — DOSSIER.md, a source file, manifest.json, VERIFY.todo.json. Reads are confined to the dossier " +
      "directory; anything else is your own file tool's job.",
    inputSchema: {
      type: "object",
      properties: {
        run: runProp,
        path: { type: "string", description: "Path relative to the dossier (e.g. 'DOSSIER.md', 'sources/S1.md'), or an absolute path inside it." },
        start_line: { type: "number", description: "First line to return, 1-based (default 1)." },
        end_line: { type: "number", description: "Last line to return, inclusive (default: end of file, capped)." },
      },
      required: ["run", "path"],
    },
    outputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "number" },
        end_line: { type: "number" },
        total_lines: { type: "number" },
        truncated: { type: "boolean" },
        content: { type: "string" },
      },
      required: ["path", "start_line", "end_line", "total_lines", "truncated", "content"],
    },
  },
];

// ultrasearch has no destructive tool: every write lands in a dossier the
// caller named, and nothing removes one. WRITE_TOOLS stays empty rather than
// absent, so the shape matches the sibling servers and --allow-write remains
// meaningful if a cache-clean tool is ever added.
export const WRITE_TOOLS: ToolDecl[] = [];

// Behavioural hints clients use to decide what needs a confirmation prompt.
//
// The read-only line is drawn at the USER'S environment. `gather`, `fetch`,
// `merge`, `brainstorm` and `render` all write a dossier — but to a directory
// the caller chose or to the temp root, never over anything a person authored.
// They are still writes: the caller is told to go open the result.
export const TOOL_META: Record<string, { write?: boolean; destructive?: boolean; idempotent?: boolean; openWorld?: boolean }> = {
  ultrasearch_search: { openWorld: true },
  ultrasearch_gather: { write: true, destructive: false, idempotent: false, openWorld: true },
  ultrasearch_fetch: { write: true, destructive: false, idempotent: true, openWorld: true },
  // Idempotent for the same reason `fetch` is: a URL already in the dossier
  // comes back as its existing [S#] rather than a second copy.
  ultrasearch_ingest: { write: true, destructive: false, idempotent: true, openWorld: true },
  ultrasearch_check: { openWorld: false },
  ultrasearch_relink: { write: true, destructive: false, idempotent: true, openWorld: false },
  ultrasearch_verify: { write: true, destructive: false, idempotent: true, openWorld: false },
  ultrasearch_render: { write: true, destructive: false, idempotent: true, openWorld: false },
  ultrasearch_plan: { openWorld: false },
  ultrasearch_merge: { write: true, destructive: false, idempotent: true, openWorld: false },
  ultrasearch_brainstorm: { write: true, destructive: false, idempotent: true, openWorld: false },
  ultrasearch_modes: { openWorld: false },
  ultrasearch_read: { openWorld: false },
};

export function annotationsFor(name: string): Record<string, boolean> | undefined {
  const meta = TOOL_META[name];
  if (!meta) return undefined;
  // Under ULTRASEARCH_NO_WRITE nothing reaches the filesystem, so every tool is
  // genuinely read-only w.r.t. the user's environment and a client should stop
  // prompting for confirmation. The annotation would otherwise describe a
  // capability the server has been stripped of.
  if (isNoWrite()) return { readOnlyHint: true, openWorldHint: meta.openWorld === true };
  return {
    readOnlyHint: !meta.write,
    ...(meta.write ? { destructiveHint: meta.destructive === true, idempotentHint: meta.idempotent === true } : {}),
    openWorldHint: meta.openWorld === true,
  };
}

export interface ToolsForOptions {
  defaultRun?: string;
  allowWrite?: boolean;
}

// The tool list as one client should see it: gated on what the server was
// started with, and on how new the negotiated protocol is.
export function toolsFor(protocolVersion: ProtocolVersion, opts: ToolsForOptions = {}): ToolDecl[] {
  const base = opts.allowWrite ? [...TOOLS, ...WRITE_TOOLS] : TOOLS;
  const withAnnotations = protocolVersion >= ANNOTATIONS_SINCE;
  const withRich = protocolVersion >= RICH_TOOLS_SINCE;

  return base.map((t) => {
    const decl: ToolDecl = {
      name: t.name,
      description: t.description,
      inputSchema: applyDefaultRun(t.inputSchema, opts.defaultRun),
    };
    if (withRich && t.title) decl.title = t.title;
    if (withRich && t.outputSchema) decl.outputSchema = t.outputSchema;
    if (withAnnotations) {
      const a = annotationsFor(t.name);
      if (a) decl.annotations = a;
    }
    return decl;
  });
}

// With a server-level default dossier, `run` stops being required and its
// description names the default — so a client working one dossier can call
// every tool with no run argument at all.
function applyDefaultRun(schema: JsonSchema, defaultRun?: string): JsonSchema {
  const existing = schema.properties.run;
  if (!defaultRun || !existing) return schema;
  return {
    type: "object",
    properties: {
      ...schema.properties,
      run: { ...existing, description: `${existing.description} Optional — defaults to ${defaultRun}.` },
    },
    required: schema.required.filter((r) => r !== "run"),
  };
}
