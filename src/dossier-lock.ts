import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
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
const held = new Map<string, Holder>();
let exitHookInstalled = false;

function releaseAllOnExit(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const [path, mine] of held) release(path, mine);
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
  // Our own pid is alive by definition, but the lock is only ours if this
  // process took it: one left by an earlier process that had the same pid (a
  // restarted container hands it out again) is as dead as any other.
  if (holder && holder.host === hostname() && holder.pid === process.pid) {
    const mine = held.get(path);
    return !mine || mine.since !== holder.since;
  }
  if (holder) return holder.host === hostname() && !alive(holder.pid);
  try {
    return Date.now() - statSync(path).mtimeMs > 10_000;
  } catch {
    return false; // gone: the next attempt will simply take it
  }
}

// Take an abandoned lock out of the way — one waiter at a time.
//
// Several waiters can see the same dead holder at once. If each of them removed
// "the lock" on that evidence, the second would remove the lock the first had
// just taken, and two writers would run. So clearing takes a lock of its own
// (`<lock>.clearing`, O_EXCL), and under it the holder is read AGAIN: only a
// lock that is still the abandoned one is removed. A live lock can only be
// removed by its own holder (see release), so nothing can replace the dead one
// between that second read and the unlink.
//
// Returns "cleared" when the lock is gone, "busy" when another waiter is on it
// (wait, then look again), or the reason it cannot be removed at all — a
// dossier directory this user may not write, say — so the caller can stop
// instead of retrying for ever.
function clearAbandoned(path: string): "cleared" | "busy" | { error: string } {
  const clearing = `${path}.clearing`;
  let fd: number;
  try {
    fd = openSync(clearing, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") return { error: (e as Error).message };
    // Another waiter is clearing. One that died doing it left this file: it
    // takes milliseconds, so one this old is nobody's.
    try {
      if (Date.now() - statSync(clearing).mtimeMs > 10_000) unlinkSync(clearing);
    } catch {
      /* gone already */
    }
    return "busy";
  }
  closeSync(fd);
  try {
    if (existsSync(path) && abandoned(path, readHolder(path))) unlinkSync(path);
    return "cleared";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "cleared" : { error: (e as Error).message };
  } finally {
    removeQuietly(clearing);
  }
}

// Remove the lock only if it is still the one this call wrote. A process
// mistaken for dead and replaced must not, on finishing, remove its successor's.
function release(path: string, mine: Holder): void {
  const now = readHolder(path);
  if (now && now.pid === mine.pid && now.host === mine.host && now.since === mine.since) removeQuietly(path);
}

function tryAcquire(path: string, command: string): Holder | undefined {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw e;
  }
  // `since` carries a counter so two locks this process takes in the same
  // millisecond are still told apart by release.
  const holder: Holder = { pid: process.pid, host: hostname(), command, since: `${new Date().toISOString()}#${++taken}` };
  try {
    writeSync(fd, JSON.stringify(holder));
  } finally {
    closeSync(fd);
  }
  return holder;
}
let taken = 0;

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
  let mine: Holder | undefined;
  while (!(mine = tryAcquire(path, command))) {
    const holder = readHolder(path);
    if (abandoned(path, holder)) {
      const cleared = clearAbandoned(path);
      if (cleared === "cleared") continue;
      if (cleared !== "busy") {
        throw new Error(`${path} was left by a process that is gone (${describe(holder)}), and could not be removed: ${cleared.error} — delete it by hand`);
      }
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
  held.set(path, mine);
  releaseAllOnExit();
  try {
    return await fn();
  } finally {
    held.delete(path);
    release(path, mine);
  }
}
