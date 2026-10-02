// The browser rung, as ultrasearch decides it.
//
// The engine can render a page in a real, separate Chrome / Brave / Chromium /
// Edge with its own profile (~/.ultrasearch/browser), which reads the JS shells
// and consent-walled pages the built-in stripper cannot. HOW it renders is the
// engine's; WHETHER it may, for this command, is decided here — once — and then
// handed to every read explicitly as the `browser` option, so behaviour never
// depends on the engine re-reading the environment mid-run.
//
// Precedence: the `--browser` flag (or the MCP `browser` argument), then
// ULTRASEARCH_BROWSER_FETCH, then the default: `fallback` when a browser is
// installed AND this session can show a window, else `off`.
//
// What the rung never does: accept a consent wall for the user (the page is
// read as it renders, banner or not), or solve a challenge (a CAPTCHA or an
// anti-bot check is reported and left to the human).
import { browserHome, closeBrowserReads, detectBrowserBinary, type BrowserBinary } from "./engine.js";
import { ALL_BROWSER_MODES, type BrowserMode } from "./types.js";

export interface BrowserRung {
  mode: BrowserMode;
  /** What decided the mode. */
  source: "flag" | "env" | "default";
  /** The browser the engine would launch; absent when none is installed. */
  binary?: BrowserBinary;
  /** Why the rung is off, or why it cannot work although it was asked for. */
  reason?: string;
}

export interface ResolveBrowserOptions {
  /** `--browser` / the MCP argument, already validated. Wins over everything. */
  flag?: BrowserMode;
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Defaults to the engine's detection (ULTRASEARCH_BROWSER_BIN, then Chrome, Brave, Chromium, Edge). */
  detect?: () => BrowserBinary | null;
}

const ENV = "ULTRASEARCH_BROWSER_FETCH";
const NO_BINARY = "no Chrome, Brave, Chromium or Edge found (install one, or point ULTRASEARCH_BROWSER_BIN at it)";

/** Whether this session can show a browser window: macOS and Windows always, Linux only under X11 or Wayland. */
export function canShowWindow(platform: NodeJS.Platform, env: Record<string, string | undefined>): boolean {
  if (platform === "darwin" || platform === "win32") return true;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export function isBrowserMode(v: string): v is BrowserMode {
  return (ALL_BROWSER_MODES as readonly string[]).includes(v);
}

/** Decide the rung for one command. Never throws. */
export function resolveBrowserRung(opts: ResolveBrowserOptions = {}): BrowserRung {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  let binary: BrowserBinary | undefined;
  let detectError: string | undefined;
  try {
    binary = (opts.detect ?? (() => detectBrowserBinary({ processEnv: env, platform, env: (suffix) => env[`ULTRASEARCH_${suffix}`] })))() ?? undefined;
  } catch (e) {
    // An explicit ULTRASEARCH_BROWSER_BIN that does not exist throws rather than
    // falling through to another browser. That is a reason, not a crash.
    detectError = e instanceof Error ? e.message : String(e);
  }
  const missing = detectError ?? NO_BINARY;
  const withBinary = (r: BrowserRung): BrowserRung => (binary ? { ...r, binary } : r);

  if (opts.flag !== undefined) {
    if (opts.flag === "off") return withBinary({ mode: "off", source: "flag", reason: "--browser off" });
    return withBinary({ mode: opts.flag, source: "flag", ...(binary ? {} : { reason: missing }) });
  }

  const raw = env[ENV]?.trim();
  if (raw) {
    // Exactly the engine's reading: anything but always/fallback is off.
    const m = raw.toLowerCase();
    if (m === "always" || m === "fallback") return withBinary({ mode: m, source: "env", ...(binary ? {} : { reason: missing }) });
    return withBinary({ mode: "off", source: "env", reason: `${ENV}=${raw}` });
  }

  if (!binary) return { mode: "off", source: "default", reason: missing };
  if (!canShowWindow(platform, env)) {
    return withBinary({ mode: "off", source: "default", reason: "no display to show a browser window in (Linux without DISPLAY or WAYLAND_DISPLAY)" });
  }
  return withBinary({ mode: "fallback", source: "default" });
}

// What the engine's own `fallback` already renders during a fetch: a refused
// read (no answer, 401, 403, 429, 503). A 2xx read that is walled or nearly
// empty is rendered too. Gone pages (404, 410, 451) are not worth a browser.
const ENGINE_RENDERS = new Set([0, 401, 403, 429, 503]);
const GONE = new Set([404, 410, 451]);

/**
 * Whether the wall rescue should try the browser on a read that came back
 * EMPTY with `status`. Only in `fallback`, and only for what the engine's own
 * fallback skipped — a 402 paywall gate, a 400, a 5xx it does not retry — so
 * a page is never rendered twice in one read. In `always` the engine rendered
 * it first; an empty result there means the browser failed already.
 */
export function rescuesEmptyRead(status: number, mode: BrowserMode): boolean {
  if (mode !== "fallback") return false;
  if (status >= 200 && status < 300) return false;
  return !ENGINE_RENDERS.has(status) && !GONE.has(status);
}

/** The `doctor` row. `ok` means a page CAN be rendered: the rung is on and has a browser to run. */
export function describeBrowserRung(r: BrowserRung): { name: "browser"; ok: boolean; detail: string } {
  if (r.mode === "off") return { name: "browser", ok: false, detail: `off — ${r.reason ?? "disabled"}` };
  if (!r.binary) return { name: "browser", ok: false, detail: `${r.mode} (from ${originOf(r)}), but ${r.reason ?? NO_BINARY}` };
  const what = r.mode === "always" ? "renders every web page" : "renders a page the built-in reader was refused, walled or handed a JS shell for";
  return {
    name: "browser",
    ok: true,
    detail:
      `${r.mode} (${originOf(r)}) — ${r.binary.kind} at ${r.binary.path}; ${what}, in its own profile (${browserHome()}). ` +
      "A window may open during a run. `--browser off` to disable.",
  };
}

function originOf(r: BrowserRung): string {
  return r.source === "flag" ? "--browser" : r.source === "env" ? ENV : "default: a browser is installed and a window can be shown";
}

/**
 * Run `fn`, then close the browser a read of THIS process launched — whatever
 * `fn` did, throw included. A browser the reads only reused, or none at all, is
 * left alone (closeBrowserReads never throws).
 */
export async function withBrowserClosed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    await closeBrowserReads();
  }
}
