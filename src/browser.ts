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
import { isNoWrite } from "./no-write.js";
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
  /** Whether this command may write nothing (--stdout / ULTRASEARCH_NO_WRITE); defaults to the no-write gate. */
  noWrite?: boolean;
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

/**
 * Decide the rung for one command. Never throws.
 *
 * Precedence: the flag, then ULTRASEARCH_BROWSER_FETCH, then the default. The
 * default is `off` under --stdout / ULTRASEARCH_NO_WRITE: a launched browser
 * writes its profile under ~/.ultrasearch/browser, and that mode promises to
 * write nothing. Detection runs only when it can change the answer — a rung
 * turned off by the flag or the env never looks for a browser.
 */
export function resolveBrowserRung(opts: ResolveBrowserOptions = {}): BrowserRung {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const detect = (): { binary?: BrowserBinary; missing: string } => {
    try {
      const found = (opts.detect ?? (() => detectBrowserBinary({ processEnv: env, platform, env: (suffix) => env[`ULTRASEARCH_${suffix}`] })))();
      return found ? { binary: found, missing: NO_BINARY } : { missing: NO_BINARY };
    } catch (e) {
      // An explicit ULTRASEARCH_BROWSER_BIN that does not exist throws rather
      // than falling through to another browser. That is a reason, not a crash.
      return { missing: e instanceof Error ? e.message : String(e) };
    }
  };
  // On, by flag or env: report the browser that will run it, or that none will.
  const on = (mode: "always" | "fallback", source: "flag" | "env"): BrowserRung => {
    const { binary, missing } = detect();
    return binary ? { mode, source, binary } : { mode, source, reason: missing };
  };

  if (opts.flag !== undefined) return opts.flag === "off" ? { mode: "off", source: "flag", reason: "--browser off" } : on(opts.flag, "flag");

  const raw = env[ENV]?.trim();
  if (raw) {
    // Exactly the engine's reading: anything but always/fallback is off.
    const m = raw.toLowerCase();
    return m === "always" || m === "fallback" ? on(m, "env") : { mode: "off", source: "env", reason: `${ENV}=${raw}` };
  }

  if (opts.noWrite ?? isNoWrite()) {
    return { mode: "off", source: "default", reason: "--stdout / ULTRASEARCH_NO_WRITE: nothing may be written, and a browser writes its profile" };
  }
  const { binary, missing } = detect();
  if (!binary) return { mode: "off", source: "default", reason: missing };
  if (!canShowWindow(platform, env)) {
    return { mode: "off", source: "default", binary, reason: "no display to show a browser window in (Linux without DISPLAY or WAYLAND_DISPLAY)" };
  }
  return { mode: "fallback", source: "default", binary };
}

/**
 * Whether the rescue should render a read that came back EMPTY with `status`.
 *
 * Only a 402, and only in `fallback`. Everything else is already the engine's:
 * its fallback renders a refused read (no answer, 401, 403, 429, 503) and a 2xx
 * that is walled or nearly empty, DURING the read — rendering those again would
 * pay for a second browser read of a page the first one could not get. A 402 is
 * the one answer it skips, and the one a paywalled news site (Le Monde) gives a
 * plain fetch while serving the article's opening to a browser. Gone pages and
 * server errors are not worth a browser. In `always` the engine rendered first.
 */
export function rescuesEmptyRead(status: number, mode: BrowserMode): boolean {
  return mode === "fallback" && status === 402;
}

/** Pages one run may render through the rescue: each is a serialized browser read of up to 30 s. */
export const BROWSER_RESCUE_CAP = 8;

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

// Page-reading calls of this process in flight. The MCP server runs several tool
// calls at once and they share the one browser the engine launched, so closing
// it is the LAST one's job: an earlier one closing it would cut a sibling's
// render off.
let sharing = 0;

/**
 * Run `fn`, then close the browser a read of THIS process launched — whatever
 * `fn` did, throw included — once no other call run this way is still in
 * flight. A browser the reads only reused, or none at all, is left alone
 * (closeBrowserReads never throws).
 */
export async function withBrowserClosed<T>(fn: () => Promise<T>): Promise<T> {
  sharing++;
  try {
    return await fn();
  } finally {
    if (--sharing === 0) await closeBrowserReads();
  }
}

/**
 * Close the browser this process's reads launched when SIGINT or SIGTERM
 * arrives, then exit (130 / 143). The engine launches it DETACHED, so a signal
 * that took only this process would leave its window behind. Returns the
 * uninstaller. The close does not wait for reads in flight: the process is
 * going either way.
 */
export function closeBrowserOnSignal(): () => void {
  const on = (sig: NodeJS.Signals) => {
    void closeBrowserReads({ waitMs: 0 }).finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", on);
  process.once("SIGTERM", on);
  return () => {
    process.off("SIGINT", on);
    process.off("SIGTERM", on);
  };
}
