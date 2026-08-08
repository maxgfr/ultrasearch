import { Readable, Writable } from 'node:stream';
import { Server } from 'node:http';

declare const ENGINE_VERSION = "1.6.0";

interface Brand {
    /** Human-readable engine consumer, used in notes and diagnostics. */
    name: string;
    /** Uppercase prefix for environment variables, without the trailing underscore. */
    envPrefix: string;
    /** The command users type, used when a note tells them what to run. */
    cli: string;
    /** Root for on-disk caches. Defaults to `<tmpdir>/<name>` when unset. */
    cacheDir?: string;
    /**
     * Where a rate-limited API maintainer can find out who is calling.
     *
     * Goes into the polite User-Agent that arXiv, Crossref, OpenAlex and friends
     * are sent. That header is a courtesy with teeth — it is how those services
     * attribute traffic and choose to throttle a well-behaved client gently
     * rather than block it — so it has to name the SKILL doing the calling, not
     * the shared engine underneath.
     */
    contactUrl?: string;
    /**
     * Words this consumer wants dropped on top of the engine's list.
     *
     * The shared list is question scaffolding — "what", "is", "the", plus the
     * French equivalents. What counts as noise BEYOND that is domain knowledge the
     * engine cannot have: a documentation tool reading source repositories sees
     * "test" and "request" in almost every file, so keeping them as keywords
     * scores every document alike. A market-research tool would say the opposite.
     *
     * This exists so adopting the shared matcher is not an all-or-nothing choice.
     * Without it a consumer with two extra words has to keep its own copy of the
     * whole keyword machinery — which is exactly the duplication being removed.
     */
    extraStopwords?: string[];
}
/**
 * Declare the consuming skill's identity. Call once, as early as possible in
 * the CLI entry point and in the MCP server bootstrap — both are process
 * entry points, and a run that starts through either must see the same brand.
 */
declare function configure(next: Brand): void;
/** The active brand. Consumers read `.cli` to name commands inside notes. */
declare function brand(): Readonly<Brand>;
/** Restore the default identity. Test-only; production code configures once. */
declare function resetBrand(): void;
/** Full variable name for a suffix, e.g. `env` name for "SEARXNG". */
declare function envName(suffix: string): string;
/**
 * Read `${envPrefix}_${suffix}`, trimmed. Returns undefined for unset OR
 * empty-after-trim, so `FOO=` and `FOO="  "` behave like unset rather than
 * like the empty string — an exported-but-blank variable is a user mistake,
 * not a request for empty configuration.
 */
declare function env(suffix: string): string | undefined;
/**
 * Presence-as-truth, matching the `if (process.env.X_NO_NPX)` shape the
 * extracted code already used. Any non-empty value except the explicit
 * negatives turns the flag on, so `NO_NPX=1`, `NO_NPX=true` and `NO_NPX=yes`
 * all work — but `NO_NPX=0` and `NO_NPX=false` read as off, because a user who
 * writes that plainly means off and the old presence-only test got it wrong.
 */
declare function envFlag(suffix: string): boolean;
/**
 * Read a numeric tunable, clamped into [min, max]. A missing, non-numeric or
 * negative-where-forbidden value falls back to `def` silently — these are
 * performance knobs, and a typo in one must never abort a run.
 *
 * Replaces three separate copies of this helper that had drifted apart (one
 * clamped, one did not, one rejected zero).
 */
declare function envInt(suffix: string, def: number, min?: number, max?: number): number;

declare function pdfToText(buf: Buffer): string;

interface PdfVerdict {
    ok: boolean;
    /** Short, human-readable cause when `ok` is false. */
    reason?: string;
}
/**
 * Judge extracted PDF text. Returns `{ ok: true }` when the text is safe to
 * cite, else a short reason the caller can put in a dossier note.
 */
declare function assessPdfText(text: string): PdfVerdict;
/**
 * Judge extracted text. Returns `{ ok: true }` when the text is safe to cite,
 * else a short reason the caller can put in a dossier note. `emptyReason` names
 * what an empty extraction means for the format at hand — a PDF with no text
 * layer was probably scanned, an empty .docx conversion means something else.
 *
 * Deliberately independent of length: the failure this guards against produces
 * HUNDREDS of kilobytes, which is exactly what a length-gated check misses.
 */
declare function assessExtractedText(text: string, emptyReason: string): PdfVerdict;

/** Test seam: forget the per-process OCR budget. */
declare function resetOcrBudget(): void;
/** Documents this process may still OCR. */
declare function ocrBudgetLeft(): number;
/**
 * Is OCR possible on this machine?
 *
 * Both binaries must resolve: `copyable-pdf` itself, and the `tesseract` it
 * shells out to. Checking tesseract separately is what keeps us out of the
 * install prompt described above — and it makes `doctor` able to say WHICH part
 * is missing, which "OCR unavailable" alone could not.
 */
declare function ocrTools(): Promise<{
    copyablePdf: boolean;
    tesseract: boolean;
}>;
/**
 * OCR a scanned PDF to text, or return undefined when it cannot be done.
 *
 * Undefined (rather than an empty string) means "this rung is unavailable or
 * failed" — the ladder's signal to try the next one and, for a non-firecrawl
 * rung, to stop asking for the rest of the process.
 */
declare function ocrPdf(bytes: Buffer): Promise<string | undefined>;

type PdfExtractorId = "pdf-inspector" | "anydoc" | "firecrawl" | "pdftotext" | "native" | "ocr";
declare const PDF_EXTRACTORS: PdfExtractorId[];
interface PdfExtraction {
    text: string;
    /** Which rung produced `text`. Absent when every rung failed. */
    via?: PdfExtractorId;
    /** Why the result is empty, when it is — suitable for a dossier note. */
    reason?: string;
}
interface PdfLadderOptions {
    /**
     * Fetch this PDF's text through an already-running Firecrawl, or undefined
     * when there is none. Injected by the caller so this module stays free of the
     * Firecrawl client (and so tests can drive the rung without a container).
     */
    firecrawl?: () => Promise<string | undefined>;
    /** Restrict/reorder the ladder. Defaults to PDF_EXTRACTORS. */
    engines?: PdfExtractorId[];
}
/** Test seam: forget which rungs were found unavailable, and refill the OCR budget. */
declare function resetPdfLadderCache(): void;
/**
 * The rungs to try, honouring `<PREFIX>_PDF_ENGINE` (force exactly one) and
 * `<PREFIX>_NO_NPX` (skip the rung that needs an implicit install), where
 * `<PREFIX>` is whatever the consuming skill declared via `configure()`.
 *
 * An explicit `engines` list wins over both: it is the most specific instruction
 * available, and it is how callers and tests drive the ladder deterministically
 * without fighting whatever the environment happens to say.
 */
declare function enabledExtractors(engines?: PdfExtractorId[]): PdfExtractorId[];
/**
 * Extract text from PDF bytes, trying each enabled rung in order and returning
 * the first result that `assessPdfText` accepts.
 *
 * Never throws. When every rung fails, returns empty text plus the LAST
 * rejection reason, so the caller can say why the source is unusable instead of
 * silently citing nothing.
 */
declare function extractPdf(bytes: Buffer, opts?: PdfLadderOptions): Promise<PdfExtraction>;

interface DocFormat {
    /** Passed as `--format` only when byte detection cannot work. */
    format?: string;
    /**
     * Is this format readable as plain text when no converter is available?
     *
     * False for every binary format: refusing is the whole point, because the
     * alternative is citing a decoded ZIP. True for CSV, which was already served
     * as usable text before this ladder existed — refusing it would be a
     * regression, not a fix.
     */
    textFallback: boolean;
}
/** Every extension this module routes, for docs and tests. */
declare const DOC_EXTENSIONS: readonly string[];
/**
 * Is this URL an office document, judged before the fetch?
 *
 * Extension-only, and deliberately so. The PDF sniffer also has to recognise
 * extension-less routes because `arxiv.org/pdf/<id>` is the single most common
 * PDF a run fetches; office documents have no such convention — a route that
 * serves one without saying so in the path is caught after the fetch, by
 * `docFormatForContentType`.
 *
 * Returns the table entry (never a URL-derived string) or undefined.
 */
declare function docFormatForUrl(url: string): DocFormat | undefined;
/** Is this response an office document, judged from its content-type? */
declare function docFormatForContentType(contentType: string): DocFormat | undefined;

type DocExtractorId = "anydoc" | "firecrawl";
declare const DOC_EXTRACTORS: DocExtractorId[];
interface DocExtraction {
    text: string;
    /** Which rung produced `text`. Absent when every rung failed. */
    via?: DocExtractorId;
    /** Why the result is empty, when it is — suitable for a dossier note. */
    reason?: string;
}
interface DocLadderOptions {
    /**
     * Convert this document through an already-running Firecrawl, or undefined
     * when there is none. Injected by the caller for the same reason the PDF
     * ladder does it: so this module needs no Firecrawl client, and so tests can
     * drive the rung without a container.
     */
    firecrawl?: () => Promise<string | undefined>;
    /** Restrict/reorder the ladder. Defaults to DOC_EXTRACTORS. */
    engines?: DocExtractorId[];
}
/** Test seam: forget which rungs were found unavailable. */
declare function resetDocLadderCache(): void;
/**
 * The rungs to try, honouring `<PREFIX>_DOC_ENGINE` (force exactly one, or
 * `none` to disable the ladder) and `<PREFIX>_NO_NPX` (skip the rung that
 * needs an implicit install), where `<PREFIX>` is whatever the consuming skill
 * declared via `configure()`.
 *
 * An explicit `engines` list wins over both, exactly as in the PDF ladder: it is
 * the most specific instruction available, and it is how callers and tests drive
 * the ladder deterministically without fighting the environment.
 */
declare function enabledDocExtractors(engines?: DocExtractorId[]): DocExtractorId[];
/**
 * Convert an office document to Markdown, trying each enabled rung in order and
 * returning the first result that the quality gate accepts.
 *
 * Never throws. When every rung fails, returns empty text plus the reason, so
 * the caller can say why the source is unusable instead of silently citing
 * nothing — or, worse, citing the raw bytes.
 */
declare function extractDocument(bytes: Buffer, fmt: DocFormat, opts?: DocLadderOptions): Promise<DocExtraction>;

declare const PDF_INSPECTOR_SPEC = "@firecrawl/pdf-inspector@1";
declare const ANYDOC_SPEC = "@firecrawl/anydoc@0.1";
interface RunResult {
    ok: boolean;
    stdout: string;
    /** Short cause when `ok` is false: "not installed", "timed out", "exit 2"… */
    error?: string;
}
/**
 * Spawn `cmd args…`, write `input` to its stdin, resolve with its stdout.
 * Never throws and never leaves a child behind: a missing binary, a non-zero
 * exit and a timeout all come back as `{ ok: false, error }`.
 */
declare function runWithInput(cmd: string, args: string[], input: Buffer, timeoutMs: number): Promise<RunResult>;

/**
 * A realistic desktop-browser User-Agent. Several keyless web endpoints (DDG,
 * Mojeek) serve 403 or empty to obvious bot UAs, so scrapers default to this.
 * Override with `<PREFIX>_UA`.
 */
declare function browserUa(): string;
/**
 * The polite, identifying User-Agent for well-behaved JSON/XML APIs (arXiv,
 * Crossref, OpenAlex, Europe PMC). Naming ourselves is what lets them
 * attribute and throttle us courteously instead of blocking outright — so it
 * names the consuming SKILL, not the shared engine underneath.
 */
declare function contactUa(): string;
/**
 * Polite pause between successive result-page fetches to the same web engine
 * (multi-page pagination). Keyless engines block aggressive scraping, so pages
 * are fetched sequentially with a small gap. Tunable; 0 disables.
 */
declare function pageDelayMs(): number;
/**
 * Polite pause between a rate-limited scholarly API's per-variant calls
 * (Crossref/OpenAlex/arXiv/Europe PMC), which the registry serialises rather
 * than firing concurrently to avoid tripping their anonymous quotas. Tunable;
 * 0 disables (tests set it to 0 to stay fast).
 */
declare function politeDelayMs(): number;
interface HttpResult {
    ok: boolean;
    status: number;
    body: string;
    contentType: string;
    url: string;
    bytes?: Buffer;
    error?: string;
}
declare function sleep(ms: number): Promise<void>;
declare function httpGet(url: string, opts?: {
    timeoutMs?: number;
    accept?: string;
    acceptLanguage?: string;
    maxBytes?: number;
    userAgent?: string;
    binary?: boolean;
}): Promise<HttpResult>;
declare function httpJson(method: string, url: string, body?: unknown, opts?: {
    timeoutMs?: number;
    accept?: string;
    acceptLanguage?: string;
    userAgent?: string;
    headers?: Record<string, string>;
}): Promise<{
    ok: boolean;
    status: number;
    data: any;
    error?: string;
}>;
declare function decodeEntities(s: string): string;
declare function cleanInline(s: string): string;
declare function htmlToText(html: string): string;
declare function htmlTitle(html: string): string | undefined;
declare function htmlCanonicalUrl(html: string): string | undefined;
declare function extractMainHtml(html: string): string;
declare const PDF_URL_RE: RegExp;
/**
 * Is this URL a PDF, judged before the fetch?
 *
 * It decides two things that both matter: whether to request BYTES (an
 * extension-less PDF fetched as text costs a second round-trip once the
 * content-type gives it away), and whether the documented extractor ladder
 * runs in its documented order. `fetchAndExtract` hands a non-PDF to Firecrawl
 * FIRST, so a misjudged PDF silently skips `pdf-inspector` — the ladder's
 * preferred rung — whenever a Firecrawl container happens to be up.
 */
declare function looksLikePdfUrl(url: string): boolean;
type ExtractorId = "native" | "firecrawl" | "pdf-inspector" | "pdftotext" | "anydoc" | "ocr";
interface ExtractResult {
    text: string;
    title?: string;
    note?: string;
    finalUrl: string;
    status: number;
    extractor?: ExtractorId;
    canonical?: string;
}
declare function fetchAndExtract(url: string, opts?: {
    acceptLanguage?: string;
    firecrawl?: string;
}): Promise<ExtractResult>;
declare const DEAD_LINK_STATUS: Set<number>;
declare function rescueViaWayback(url: string, opts?: {
    acceptLanguage?: string;
    firecrawl?: string;
}): Promise<{
    text: string;
    title?: string;
    snapshotUrl: string;
    timestamp: string;
} | undefined>;
declare function looksLikeJunkExtraction(text: string): string | undefined;
declare function nearestHeading(lines: string[], anchor: number): string | undefined;
declare function focusedSnippet(text: string, question: string, opts?: {
    maxChars?: number;
    maxSentences?: number;
}): string;
declare function bestExcerpt(text: string, question: string, maxChars?: number): string;
declare function capExtract(text: string, depth: "summary" | "standard" | "deep"): string;

declare const FIRECRAWL_DEFAULT_BASE = "http://localhost:3002";
interface FirecrawlOptions {
    /** `--firecrawl <url>`; "off" disables Firecrawl entirely. */
    firecrawl?: string;
}
/**
 * Resolve the configured Firecrawl base: an explicit `--firecrawl` wins, else
 * `<PREFIX>_FIRECRAWL`, else the localhost default. The literal value `off`
 * (either source) disables Firecrawl entirely and returns null.
 */
declare function firecrawlBase(opts?: FirecrawlOptions): string | null;
/** True when the base came from the user (flag or env) rather than the default. */
declare function firecrawlIsExplicit(opts?: FirecrawlOptions): boolean;
/**
 * Test seam: forget which bases were probed.
 *
 * The memoisation is per-process and deliberately sticky — the whole cost of an
 * absent Firecrawl is meant to be one refused connection. That is right in
 * production and wrong across test cases, where one case's "down" verdict would
 * silently decide the next case's behaviour. Mirrors resetOcrBudget,
 * resetPdfLadderCache and resetDocLadderCache.
 */
declare function resetFirecrawlProbeCache(): void;
/**
 * Decide whether the thing that answered `GET {base}/` is actually Firecrawl.
 *
 * "Something is listening" is NOT the same question, and conflating them is a
 * real trap: 3002 is a common dev port, so a Next.js/Vite app squatting it
 * answers 200 and every page extraction then POSTs to an app that 404s — each
 * one paying a wasted round-trip before falling back, while `doctor` cheerfully
 * reports "firecrawl answering". A false positive here is worse than a false
 * negative, because it is invisible.
 *
 * The rule: an HTML page with no Firecrawl marker is somebody else's app.
 * Anything else (its JSON root, an empty body, a proxy's 404) is accepted, so
 * the reverse-proxy case the original probe protected still works. Exported for
 * unit tests — this is a decision, not a detail.
 */
declare function looksLikeFirecrawl(contentType: string | null, body: string): boolean;
/**
 * Is a Firecrawl instance answering at `base`? `GET {base}/` with a hard 2s
 * ceiling. The response must also look like Firecrawl (see above) unless the
 * caller named the instance itself — pointing `--firecrawl` somewhere is a
 * statement about what lives there, and it may legitimately sit behind a proxy
 * that masks the root. Connection refused / timeout ⇒ down. Memoised for the
 * process, so the whole cost of an absent Firecrawl is one refused connection.
 * Never throws.
 *
 * Deliberately bypasses `httpGet`: that layer retries once with a backoff,
 * which would turn a 2s ceiling into ~4.6s on a blackholed host. A probe wants
 * a single shot.
 */
declare function probeFirecrawl(base: string, explicit?: boolean): Promise<boolean>;
/** The API prefix in use for `base`: `/v2` until a 404 proves it is `/v1`. */
declare function apiPrefix(base: string): string;
/** A page as Firecrawl returned it: main-content markdown plus provenance. */
interface FirecrawlScrape {
    markdown: string;
    title?: string;
    sourceURL?: string;
    statusCode?: number;
}
/**
 * PURE mapper for a `/scrape` response body → the fields the extractor needs,
 * or null when there is nothing usable: `{success:false}`, a missing/non-object
 * `data`, or empty markdown. Exported so the response contract is unit-tested
 * against a fixture instead of the network.
 */
declare function mapScrapeResponse(json: any): FirecrawlScrape | null;
/** One `web` hit from a `/search` response. */
interface FirecrawlHit {
    url: string;
    title: string;
    description: string;
    markdown?: string;
}
/**
 * PURE mapper for a `/search` response body → the `web` hits. Tolerates the
 * shape drifting to a bare array or to `data.results`, and drops any entry
 * without a usable URL. Never throws.
 */
declare function mapSearchResponse(json: any): FirecrawlHit[];
/** What a scrape attempt tells the caller: the page, or WHY it fell through. */
interface ScrapeAttempt {
    data?: FirecrawlScrape;
    /**
     * A user-visible reason the caller should surface as a note. Only set when
     * Firecrawl was actually REACHED and still produced nothing — an unreachable
     * or disabled instance is silent (see the note-policy comment in fetch.ts).
     */
    why?: string;
}
/**
 * Scrape one URL through Firecrawl, returning the cleaned markdown or the
 * reason it could not. A single `/scrape` call — never `/batch/scrape`, which is
 * an async job + polling protocol not worth the complexity for one page.
 * Returns `{}` (silently) when Firecrawl is disabled or unreachable.
 */
declare function scrapeViaFirecrawl(url: string, opts?: FirecrawlOptions): Promise<ScrapeAttempt>;
/**
 * Query Firecrawl's keyless `/search` (Fire-Engine → SearXNG → DuckDuckGo
 * internally). Returns the `web` hits, or a reason.
 */
declare function searchViaFirecrawl(query: string, limit: number, opts?: FirecrawlOptions): Promise<{
    hits?: FirecrawlHit[];
    why?: string;
}>;

declare function escapeRegExp(s: string): string;
/**
 * Is this term question scaffolding rather than content?
 *
 * Exported because a consumer's own scorer must agree with buildMatcher on what
 * a term IS. ultrasearch's BM25 tokeniser drops the same words and applies the
 * same folding, so a document ranks against the same vocabulary the excerpt
 * matcher highlights. Two lists that drift apart make the two disagree, and the
 * symptom — a source that scores well but shows an excerpt with no highlight —
 * looks like a bug in neither.
 */
declare function isStopword(term: string): boolean;
declare function keywords(question: string): string[];
declare function rankedKeywords(question: string): string[];
declare function deaccent(s: string): string;
declare function foldTerm(raw: string): string;
declare function subtokens(raw: string): string[];
interface KeywordVariant {
    text: string;
    kind: "original" | "folded" | "subtoken";
}
interface ExpandedKeyword {
    canonical: string;
    original: string;
    variants: KeywordVariant[];
}
declare function expandTokens(tokens: string[], max?: number): ExpandedKeyword[];
declare function accentPattern(text: string): string;
interface KeywordMatcher {
    expanded: ExpandedKeyword[];
    canonicals: string[];
    /**
     * The compiled pattern sources, each with the keyword it attributes to.
     *
     * What makes the matcher usable by something other than this process: a
     * consumer can hand these to ripgrep or any external scanner and still map
     * the hits back to canonicals. Without them the matcher only works line by
     * line in memory, which is the wrong shape for searching a whole repository.
     */
    patterns: {
        source: string;
        canonical: string;
    }[];
    /** Map a matched span — as an external scanner reports it — back to its keyword. */
    canonicalOf(span: string): string | undefined;
    /** Which canonicals does this line of text cover? */
    matchLine(line: string): Set<string>;
}
declare function buildMatcher(question: string, max?: number): KeywordMatcher;
/**
 * A matcher over raw tokens, skipping keyword extraction.
 *
 * The fallback for a question with no distinctive keywords left after stopword
 * removal — "what is it for?" reduces to nothing, and a matcher that matches
 * nothing highlights nothing. Searching the words as given is worse than a good
 * query and much better than an empty one. Still accent-folded and
 * subtoken-expanded, so attribution stays consistent with buildMatcher.
 */
declare function matcherFromTokens(tokens: string[], max?: number): KeywordMatcher;

declare function canonicalizeUrl(raw: string): string;
declare function normalizeDoi(doi: string): string;
declare function domainOf(raw: string): string;
/** The `domain` a local file is filed under. Not a host, and deliberately not one. */
declare const LOCAL_FILE_DOMAIN = "local file";
declare function fnv1a64(s: string): bigint;

type Extract = Awaited<ReturnType<typeof fetchAndExtract>>;
declare function cacheDir(): string;
declare function cachePath(url: string, acceptLanguage?: string, extractor?: CacheNamespace): string;
declare const PDF_CACHE_NS: "pdf";
declare const DOC_CACHE_NS: "doc";
type CacheNamespace = ExtractorId | typeof PDF_CACHE_NS | typeof DOC_CACHE_NS;
declare function cachedFetchAndExtract(url: string, opts?: {
    acceptLanguage?: string;
    firecrawl?: string;
}, enabled?: boolean, now?: number): Promise<Extract & {
    cached?: boolean;
}>;

interface Artifact {
    /** Path the artifact WOULD have been written to. */
    path: string;
    content: string;
}
declare function setNoWrite(on: boolean): void;
declare function isNoWrite(): boolean;
/** mkdirSync -p, or nothing at all under no-write. */
declare function ensureDir(dir: string): void;
/**
 * Write a file, or collect it under no-write. Returns the path either way — so
 * callers keep their existing shape — which means a caller that PRINTS the
 * returned path must check `isNoWrite()` first, or it advertises a file that
 * does not exist. The CLI does exactly that.
 */
declare function writeArtifact(path: string, content: string): string;
/** Drain the collected artifacts. Empty when writes actually went to disk. */
declare function takeArtifacts(): Artifact[];
/** Test seam: clear both the switch and anything collected under it. */
declare function resetNoWrite(): void;

declare const PROTOCOL_VERSIONS: readonly ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];
declare const LATEST_PROTOCOL: ProtocolVersion;
declare const ASSUMED_HTTP_PROTOCOL: ProtocolVersion;
declare const ANNOTATIONS_SINCE = "2025-03-26";
declare const RICH_TOOLS_SINCE = "2025-06-18";
declare const DEFAULT_MAX_RESPONSE_BYTES = 1000000;
declare function isProtocolVersion(v: unknown): v is ProtocolVersion;
declare function negotiateProtocol(requested: unknown): ProtocolVersion;
interface JsonSchemaProp {
    type?: "string" | "number" | "boolean" | "array" | "object";
    items?: {
        type?: string;
    };
    enum?: readonly string[];
    description?: string;
}
interface JsonSchema {
    type: "object";
    properties: Record<string, JsonSchemaProp>;
    required: string[];
}
declare function validateArgs(schema: JsonSchema, args: Record<string, unknown>): string | undefined;
/**
 * How to ask for less, per tool name.
 *
 * A cap that only says "too big" makes the model retry the same call; one that
 * names the narrowing argument gets a smaller second call. Which argument that
 * is depends entirely on the tool, so the map is supplied by the consuming
 * skill through McpAdapter.capAdvice — the engine knows a response is oversized,
 * only the skill knows how to make it smaller.
 */
type CapAdvice = Record<string, string>;
declare function capResponse(text: string, tool: string, maxBytes: number, artifact?: string, advice?: CapAdvice): string;
declare function structuredContentFor(text: string, capped: boolean, hasSchema: boolean): Record<string, unknown> | undefined;
declare function isOriginAllowed(origin: string | undefined, allowed?: string[]): boolean;

interface JsonRpcMessage {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
    [k: string]: unknown;
}
interface ToolDecl {
    name: string;
    description: string;
    inputSchema: JsonSchema;
    title?: string;
    outputSchema?: JsonSchema;
    annotations?: Record<string, boolean>;
}
interface PromptDecl {
    name: string;
    title?: string;
    description?: string;
    arguments?: {
        name: string;
        description?: string;
        required?: boolean;
    }[];
}
interface PromptResult {
    description?: string;
    messages: {
        role: string;
        content: {
            type: string;
            text: string;
        };
    }[];
}
/** What a tool handler gives back: text for the model, plus an optional artifact path. */
interface ToolOutcome {
    text: string;
    artifact?: string;
}
/**
 * Thrown for anything the caller can fix by calling again differently. The
 * server turns it into an `isError` tool result, never a JSON-RPC error: the
 * tool ran, the request was wrong or the world didn't cooperate.
 *
 * Lives here rather than in each skill so the distinction is decided in ONE
 * place. Conflating a tool failure with a protocol error hides a client bug
 * inside a model-readable result the model then tries to reason around.
 */
declare class ToolError extends Error {
}
/** Thrown for an unknown prompt or a missing required argument. A client bug. */
declare class PromptError extends Error {
}
/**
 * The skill half of the server. Everything the engine cannot know.
 *
 * `listTools` takes the negotiated protocol version because tool declarations
 * are version-gated: annotations and output schemas only exist from certain
 * revisions onward, and advertising them to an older client is a spec
 * violation.
 */
interface McpAdapter {
    /** Version reported in `serverInfo`. The skill's, not the engine's. */
    version: string;
    listTools(protocol: ProtocolVersion): ToolDecl[];
    callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
    /**
     * Per-tool advice for narrowing an oversized request. The engine detects the
     * overflow; only the skill knows which argument makes the result smaller.
     */
    capAdvice?: CapAdvice;
    /** Omit to advertise no prompts; the capability is declared either way. */
    prompts?: PromptDecl[];
    getPrompt?(name: string, args: Record<string, unknown>): PromptResult;
}
interface ServerOptions {
    maxResponseBytes?: number;
    /** Defaults to the brand name. */
    serverName?: string;
    skillDir?: string;
}
declare const ERR_INVALID_REQUEST = -32600;
declare const ERR_METHOD_NOT_FOUND = -32601;
declare const ERR_INVALID_PARAMS = -32602;
declare const ERR_INTERNAL = -32603;
interface McpServer {
    handle(msg: JsonRpcMessage, send: (out: JsonRpcMessage) => void): Promise<void>;
    protocolVersion(): ProtocolVersion;
    setProtocolVersion(v: ProtocolVersion): void;
    tools(): ToolDecl[];
}
declare function createServer(adapter: McpAdapter, opts?: ServerOptions): McpServer;

interface StdioOptions extends ServerOptions {
    input?: Readable;
    output?: Writable;
    captureStdout?: boolean;
}
declare function runStdioServer(adapter: McpAdapter, opts?: StdioOptions): Promise<void>;

interface HttpOptions extends ServerOptions {
    port?: number;
    bind?: string;
    allowOrigin?: string[];
    allowRemote?: boolean;
}
interface RunningHttpServer {
    server: Server;
    port: number;
    url: string;
    close(): Promise<void>;
}
declare function startHttpServer(adapter: McpAdapter, opts?: HttpOptions): Promise<RunningHttpServer>;

/**
 * Display name used in resource titles. Comes from the brand, so ultradoc's
 * resources say "ultradoc: the skill" and construct's say "construct: …".
 */
declare const skillName: () => string;
interface ResourceDecl {
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType: string;
}
interface ResourceContents {
    uri: string;
    mimeType: string;
    text: string;
}
declare function resolveSkillRoot(moduleDir?: string): string | undefined;
declare function listResources(moduleDir?: string): ResourceDecl[];
declare function readResource(uri: string, moduleDir?: string): ResourceContents;
declare class ResourceError extends Error {
}

export { ANNOTATIONS_SINCE, ANYDOC_SPEC, ASSUMED_HTTP_PROTOCOL, type Artifact, type Brand, type CapAdvice, DEAD_LINK_STATUS, DEFAULT_MAX_RESPONSE_BYTES, DOC_EXTENSIONS, DOC_EXTRACTORS, type DocExtraction, type DocExtractorId, type DocFormat, type DocLadderOptions, ENGINE_VERSION, ERR_INTERNAL, ERR_INVALID_PARAMS, ERR_INVALID_REQUEST, ERR_METHOD_NOT_FOUND, type ExpandedKeyword, type ExtractResult, type ExtractorId, FIRECRAWL_DEFAULT_BASE, type FirecrawlHit, type FirecrawlOptions, type FirecrawlScrape, type HttpOptions, type HttpResult, type JsonRpcMessage, type JsonSchema, type JsonSchemaProp, type KeywordMatcher, type KeywordVariant, LATEST_PROTOCOL, LOCAL_FILE_DOMAIN, type McpAdapter, type McpServer, PDF_EXTRACTORS, PDF_INSPECTOR_SPEC, PDF_URL_RE, PROTOCOL_VERSIONS, type PdfExtraction, type PdfExtractorId, type PdfLadderOptions, type PdfVerdict, type PromptDecl, PromptError, type PromptResult, type ProtocolVersion, RICH_TOOLS_SINCE, type ResourceContents, type ResourceDecl, ResourceError, type RunningHttpServer, type ScrapeAttempt, type ServerOptions, type StdioOptions, type ToolDecl, ToolError, type ToolOutcome, accentPattern, apiPrefix, assessExtractedText, assessPdfText, bestExcerpt, brand, browserUa, buildMatcher, cacheDir, cachePath, cachedFetchAndExtract, canonicalizeUrl, capExtract, capResponse, cleanInline, configure, contactUa, createServer, deaccent, decodeEntities, docFormatForContentType, docFormatForUrl, domainOf, enabledDocExtractors, enabledExtractors, ensureDir, env, envFlag, envInt, envName, escapeRegExp, expandTokens, extractDocument, extractMainHtml, extractPdf, fetchAndExtract, firecrawlBase, firecrawlIsExplicit, fnv1a64, focusedSnippet, foldTerm, htmlCanonicalUrl, htmlTitle, htmlToText, httpGet, httpJson, isNoWrite, isOriginAllowed, isProtocolVersion, isStopword, keywords, listResources, looksLikeFirecrawl, looksLikeJunkExtraction, looksLikePdfUrl, mapScrapeResponse, mapSearchResponse, matcherFromTokens, nearestHeading, negotiateProtocol, normalizeDoi, ocrBudgetLeft, ocrPdf, ocrTools, pageDelayMs, pdfToText, politeDelayMs, probeFirecrawl, rankedKeywords, readResource, rescueViaWayback, resetBrand, resetDocLadderCache, resetFirecrawlProbeCache, resetNoWrite, resetOcrBudget, resetPdfLadderCache, resolveSkillRoot, runStdioServer, runWithInput, scrapeViaFirecrawl, searchViaFirecrawl, setNoWrite, skillName, sleep, startHttpServer, structuredContentFor, subtokens, takeArtifacts, validateArgs, writeArtifact };
