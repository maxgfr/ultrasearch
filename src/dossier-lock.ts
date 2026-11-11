import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { envInt } from "./engine.js";
import { isNoWrite } from "./no-write.js";

// One writer per dossier, across processes.
//
// `withRunLock` serialises the calls of ONE process — the MCP server. Two
// processes are the case it leaves open, and the ordinary way to hit it is an
// agent running several `fetch --out D` at once: each reads sources.json, takes
// the highest id, and writes back. Every file is written atomically, so nothing
// is torn — the last writer simply wins and a source is silently gone, while a
// citation to its id still resolves, to another page.
//
// So every command that rewrites a dossier holds `<dossier>/.ultrasearch.lock`
// while it runs. The file is created with O_EXCL, which is atomic on every
// filesystem this runs on, and names its holder. A second writer waits for it —
// a queue of fetches is the point, not an error — and says so once. A holder
// that died without releasing (a kill, a crash) is recognised by its pid and
// replaced, so a dead lock never has to be cleared by hand on the machine that
// left it.
//
// Not locked, on purpose: a command that only reads (`check`, `doctor`), one
// that writes its own stand-alone file and never the index (`plan`,
// `brainstorm`, `orchestrate`), and a directory that does not exist yet — work
// that creates its directory has nothing to contend for.

export const LOCK_FILE = ".ultrasearch.lock";

interface Holder {
  pid: number;
  host: string;
  command: string;
  since: string;
}

// The dossiers this process holds, so a `process.exit` — which skips every
// `finally` — still releases them.
const held = new Set<string>();
let exitHookInstalled = false;

function releaseAllOnExit(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const path of held) removeQuietly(path);
  });
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

function readHolder(path: string): Holder | undefined {
  try {
    const h = JSON.parse(readFileSync(path, "utf8")) as Partial<Holder>;
    return typeof h.pid === "number" && typeof h.host === "string"
      ? { pid: h.pid, host: h.host, command: String(h.command ?? "?"), since: String(h.since ?? "") }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a process with this pid exists on this machine. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists and belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A lock nobody holds any more: its process is gone from this machine, or the
// file never got its holder written (a crash between the two steps) and has
// been sitting there for longer than that takes.
function abandoned(path: string, holder: Holder | undefined): boolean {
  if (holder) return holder.host === hostname() && !alive(holder.pid);
  try {
    return Date.now() - statSync(path).mtimeMs > 10_000;
  } catch {
    return false; // gone: the next attempt will simply take it
  }
}

// Take an abandoned lock out of the way. Renamed rather than deleted, and
// checked afterwards: between reading the dead holder and acting on it another
// waiter may already have replaced the lock, and deleting THAT would let two
// writers in. A live lock renamed by mistake is put back.
function clearAbandoned(path: string, holder: Holder | undefined): void {
  const aside = `${path}.${process.pid}.stale`;
  try {
    renameSync(path, aside);
  } catch {
    return; // someone else cleared it first
  }
  const moved = readHolder(aside);
  if (moved && (moved.pid !== holder?.pid || moved.since !== holder?.since) && !existsSync(path)) {
    try {
      renameSync(aside, path);
      return;
    } catch {
      /* fall through: drop it */
    }
  }
  removeQuietly(aside);
}

function tryAcquire(path: string, command: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    const holder: Holder = { pid: process.pid, host: hostname(), command, since: new Date().toISOString() };
    writeSync(fd, JSON.stringify(holder));
  } finally {
    closeSync(fd);
  }
  return true;
}

export interface DossierLockOptions {
  /** How long to wait for another writer, in ms (default ULTRASEARCH_LOCK_WAIT_MS, else 10 minutes). */
  waitMs?: number;
  /** Gap between two attempts, in ms (default 150). */
  pollMs?: number;
  /** Told once, when this call starts waiting on another writer. */
  onWait?: (message: string) => void;
}

const describe = (h: Holder | undefined): string =>
  h ? `pid ${h.pid}${h.host === hostname() ? "" : ` on ${h.host}`}, \`${h.command}\`, since ${h.since}` : "an unidentified process";

/**
 * Run `fn` as the only ultrasearch process writing `dir`.
 *
 * A no-op when nothing can be written (`--stdout`) and when `dir` does not
 * exist. Waits for a live holder, replaces a dead one, and throws — naming the
 * holder and the file — when the wait runs out.
 */
export async function withDossierLock<T>(dir: string, command: string, fn: () => Promise<T> | T, opts: DossierLockOptions = {}): Promise<T> {
  if (isNoWrite() || !existsSync(dir)) return fn();
  const path = join(dir, LOCK_FILE);
  const waitMs = opts.waitMs ?? envInt("LOCK_WAIT_MS", 600_000, 0, 86_400_000);
  const pollMs = opts.pollMs ?? 150;
  const deadline = Date.now() + waitMs;
  let told = false;
  while (!tryAcquire(path, command)) {
    const holder = readHolder(path);
    if (abandoned(path, holder)) {
      clearAbandoned(path, holder);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${dir} is being written by another ultrasearch process (${describe(holder)}) and did not come free in ${Math.round(waitMs / 1000)} s — ` +
          `wait for it, or delete ${path} if that process is gone`,
      );
    }
    if (!told) {
      told = true;
      opts.onWait?.(`waiting for another ultrasearch process to finish writing ${dir} (${describe(holder)})`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  held.add(path);
  releaseAllOnExit();
  try {
    return await fn();
  } finally {
    held.delete(path);
    removeQuietly(path);
  }
}
