import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { runGather } from "../src/gather.js";
import { runMerge } from "../src/merge.js";
import { readDossier, reportsOverwritten, RENUMBERS } from "../src/dossier.js";
import { LOCK_FILE, withDossierLock } from "../src/dossier-lock.js";
import { setNoWrite } from "../src/no-write.js";
import { callTool } from "../src/mcp/handlers.js";
import { installFetchMock } from "./fetchmock.js";
import type { GatherOptions } from "../src/types.js";

// The committed bundle: what a second process actually is.
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ultrasearch.mjs");

const temps: string[] = [];
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "us-guard-"));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  setNoWrite(false);
});

function opts(over: Partial<GatherOptions>): GatherOptions {
  return {
    question: "what is rate limiting",
    mode: "topic",
    depth: "standard",
    maxSources: 25,
    perSource: 6,
    lang: "en",
    webEngine: "auto",
    excludeDomains: [],
    json: false,
    backends: ["fixture"],
    ...over,
  };
}

const REPORT = (id: string) => `# Report\n\nRate limiting caps the request rate to protect a service [${id}].\n`;

describe("a dossier that holds a report is not renumbered under it", () => {
  it("gather refuses an --out holding a report, before it searches anything", async () => {
    const dir = temp();
    await runGather(opts({ out: dir }));
    writeFileSync(join(dir, "REPORT.md"), REPORT("S1"));
    const before = readFileSync(join(dir, "sources.json"), "utf8");
    // A network backend: had the guard run late, it would have been asked.
    const spy = installFetchMock(() => ({ body: "{}", contentType: "application/json" }));
    await expect(runGather(opts({ out: dir, question: "something else entirely", backends: ["wikipedia"] }))).rejects.toThrow(
      /already holds REPORT\.md from an earlier run, and a new gather numbers its sources from S1 again.* --force/,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "sources.json"), "utf8")).toBe(before);
  });

  it("is not set off by a rendered page alone: only the tiers cite [S#] ids", async () => {
    const dir = temp();
    writeFileSync(join(dir, "index.html"), "<p>someone else's page</p>");
    await expect(runGather(opts({ out: dir }))).resolves.toBeDefined();
  });

  it("a re-gather that finds nothing leaves the previous extracts on disk", async () => {
    const dir = temp();
    const first = await runGather(opts({ out: dir }));
    installFetchMock(() => ({ status: 503, body: "" }));
    const empty = await runGather(opts({ out: dir, backends: ["wikipedia"] }));
    expect(empty.sources).toEqual([]);
    for (const s of first.sources) expect(existsSync(join(dir, s.extract)), s.extract).toBe(true);
  });

  it("an MCP gather that writes nothing is not refused", async () => {
    const dir = temp();
    writeFileSync(join(dir, "REPORT.md"), REPORT("S1"));
    process.env.ULTRASEARCH_NO_WRITE = "1";
    try {
      const res = await callTool("ultrasearch_gather", { question: "what is rate limiting", backends: ["fixture"], out: dir });
      expect(JSON.parse(res.text).run).toBeNull();
    } finally {
      delete process.env.ULTRASEARCH_NO_WRITE;
    }
  });

  it("gather --force writes there, keeps the report, and says it predates the run", async () => {
    const dir = temp();
    await runGather(opts({ out: dir }));
    writeFileSync(join(dir, "REPORT.md"), REPORT("S1"));
    const r = await runGather(opts({ out: dir, force: true }));
    expect(readFileSync(join(dir, "REPORT.md"), "utf8")).toBe(REPORT("S1"));
    expect(r.manifest.notes[0]).toMatch(/^REPORT\.md predates this run: the \[S#\] ids there cite the previous sources/);
    expect(readFileSync(join(dir, "DOSSIER.md"), "utf8")).toContain("REPORT.md predates this run");
  });

  it("gather into a dossier with no report is not refused, and clears the extracts the new run does not use", async () => {
    const dir = temp();
    const first = await runGather(opts({ out: dir }));
    const extracts = first.sources.map((s) => `S${s.id.slice(1)}.md`);
    // What an earlier, larger run left behind — and a hand-kept note beside
    // the extracts, which is nobody's to delete.
    writeFileSync(join(dir, "sources", "S98.md"), "# S98 — a page the previous run kept\n");
    writeFileSync(join(dir, "sources", "notes.md"), "mine");
    await runGather(opts({ out: dir }));
    expect(readdirSync(join(dir, "sources")).sort()).toEqual([...extracts, "notes.md"].sort());
  });

  it("a gather into a new or default directory, and one that writes nothing, are never refused", async () => {
    const dir = temp();
    writeFileSync(join(dir, "REPORT.md"), REPORT("S1"));
    setNoWrite(true);
    await expect(runGather(opts({ out: dir, stdout: true }))).resolves.toBeDefined();
    setNoWrite(false);
    expect(reportsOverwritten(join(dir, "not-there-yet"), false, RENUMBERS("gather"))).toEqual([]);
  });

  it("merge refuses a --master holding a report unless forced", async () => {
    const a = temp();
    const master = temp();
    await runGather(opts({ out: a }));
    runMerge({ runs: [a], master });
    writeFileSync(join(master, "SUMMARY.md"), "# Summary\n");
    expect(() => runMerge({ runs: [a], master })).toThrow(/already holds SUMMARY\.md from an earlier run, and a new merge numbers its sources from S1 again/);
    const forced = runMerge({ runs: [a], master, force: true });
    expect(forced.manifest.notes.at(-1)).toMatch(/^SUMMARY\.md predates this run/);
  });

  it("the CLI takes --force for gather and merge, and exits 1 without it", async () => {
    const dir = temp();
    await runGather(opts({ out: dir }));
    writeFileSync(join(dir, "REPORT.md"), REPORT("S1"));
    const args = ["gather", "--q", "what is rate limiting", "--backends", "fixture", "--out", dir];
    const refused = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/ultrasearch: .* already holds REPORT\.md from an earlier run/);
    expect(spawnSync(process.execPath, [CLI, ...args, "--force"], { encoding: "utf8" }).status).toBe(0);
  });

  it("the MCP tools refuse the same way, as a tool failure naming `force`", async () => {
    const dir = temp();
    await runGather(opts({ out: dir }));
    writeFileSync(join(dir, "REPORT.md"), REPORT("S1"));
    await expect(callTool("ultrasearch_gather", { question: "what is rate limiting", backends: ["fixture"], out: dir })).rejects.toThrow(
      /already holds REPORT\.md.*`force: true`/,
    );
    await expect(callTool("ultrasearch_merge", { runs: [dir], master: dir })).rejects.toThrow(/already holds REPORT\.md/);
    const ok = await callTool("ultrasearch_gather", { question: "what is rate limiting", backends: ["fixture"], out: dir, force: true });
    expect(JSON.parse(ok.text).run).toBe(dir);
  });
});

describe("one writer per dossier, across processes", () => {
  const lockOf = (dir: string) => join(dir, LOCK_FILE);
  const holder = (pid: number, host = hostname()) => JSON.stringify({ pid, host, command: "fetch", since: "2026-11-10T10:00:00.000Z" });
  // A pid no process has: far above any real pid range, still a valid integer for kill(2).
  const DEAD_PID = 2 ** 30;

  it("holds the lock file while the work runs, and removes it after — on a throw too", async () => {
    const dir = temp();
    await withDossierLock(dir, "fetch", () => {
      expect(JSON.parse(readFileSync(lockOf(dir), "utf8"))).toMatchObject({ pid: process.pid, command: "fetch" });
    });
    expect(existsSync(lockOf(dir))).toBe(false);
    await expect(
      withDossierLock(dir, "fetch", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(lockOf(dir))).toBe(false);
  });

  it("makes a second writer wait for the first instead of running beside it", async () => {
    const dir = temp();
    const order: string[] = [];
    const waited: string[] = [];
    const first = withDossierLock(dir, "ingest", async () => {
      order.push("first in");
      await new Promise((r) => setTimeout(r, 60));
      order.push("first out");
    });
    const second = withDossierLock(dir, "fetch", () => void order.push("second in"), { pollMs: 5, onWait: (m) => waited.push(m) });
    await Promise.all([first, second]);
    expect(order).toEqual(["first in", "first out", "second in"]);
    expect(waited).toHaveLength(1);
    expect(waited[0]).toContain(`pid ${process.pid}, \`ingest\``);
  });

  it("replaces the lock of a process that died without releasing it", async () => {
    const dir = temp();
    writeFileSync(lockOf(dir), holder(DEAD_PID));
    let ran = false;
    await withDossierLock(dir, "fetch", () => void (ran = true), { waitMs: 0 });
    expect(ran).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("gives up on a live holder after the wait, naming it and the file to delete", async () => {
    const dir = temp();
    // The process that started this test runner: alive, and not us.
    writeFileSync(lockOf(dir), holder(process.ppid));
    await expect(withDossierLock(dir, "fetch", () => undefined, { waitMs: 30, pollMs: 5 })).rejects.toThrow(
      new RegExp(`is being written by another ultrasearch process \\(pid ${process.ppid}, \`fetch\`, since 2026-11-10.*delete .*\\${LOCK_FILE}`),
    );
    // A lock it does not own is left exactly as found.
    expect(readFileSync(lockOf(dir), "utf8")).toBe(holder(process.ppid));
  });

  it("takes over a lock bearing its own pid that it never took — a restarted container reuses pids", async () => {
    const dir = temp();
    writeFileSync(lockOf(dir), holder(process.pid));
    let ran = false;
    await withDossierLock(dir, "fetch", () => void (ran = true), { waitMs: 0 });
    expect(ran).toBe(true);
  });

  it("stops at once, naming the file, when a dead lock cannot be removed", async () => {
    const dir = temp();
    writeFileSync(lockOf(dir), holder(DEAD_PID));
    chmodSync(dir, 0o555);
    try {
      const t0 = Date.now();
      await expect(withDossierLock(dir, "drop", () => undefined, { waitMs: 60_000, pollMs: 5 })).rejects.toThrow(
        /was left by a process that is gone .* could not be removed: .* delete it by hand/,
      );
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it("never removes a lock that is no longer the one it took", async () => {
    const dir = temp();
    const successor = holder(process.pid);
    await withDossierLock(dir, "fetch", () => {
      // Mistaken for dead and replaced while it ran: the successor's lock stays.
      writeFileSync(lockOf(dir), successor);
    });
    expect(readFileSync(lockOf(dir), "utf8")).toBe(successor);
  });

  it("lets one waiter at a time clear a dead lock, so two waiters never both get in", async () => {
    const dir = temp();
    writeFileSync(lockOf(dir), holder(DEAD_PID));
    let inside = 0;
    let most = 0;
    const work = () =>
      withDossierLock(
        dir,
        "fetch",
        async () => {
          most = Math.max(most, ++inside);
          await new Promise((r) => setTimeout(r, 15));
          inside--;
        },
        { pollMs: 1 },
      );
    await Promise.all(Array.from({ length: 6 }, work));
    expect(most).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("cannot tell whether a holder on another machine is alive, so it waits for it", async () => {
    const dir = temp();
    writeFileSync(lockOf(dir), holder(DEAD_PID, "another-host.test"));
    await expect(withDossierLock(dir, "fetch", () => undefined, { waitMs: 20, pollMs: 5 })).rejects.toThrow(/pid \d+ on another-host\.test/);
  });

  it("takes no lock for a directory that does not exist, or when nothing can be written", async () => {
    const dir = temp();
    const missing = join(dir, "nope");
    await withDossierLock(missing, "render", () => undefined);
    expect(existsSync(missing)).toBe(false);
    writeFileSync(lockOf(dir), holder(process.pid));
    setNoWrite(true);
    let ran = false;
    await withDossierLock(dir, "gather", () => void (ran = true), { waitMs: 0 });
    expect(ran).toBe(true);
  });

  it("two processes adding a source to one dossier get two ids, not the same one twice", async () => {
    const dir = temp();
    const gathered = (await runGather(opts({ out: dir }))).sources.length;
    const pages = join(dir, "pages");
    mkdirSync(pages);
    const text = (n: number) => `Page ${n}. ` + `Rate limiting protects a service from overload by capping requests, variant ${n}. `.repeat(30);
    const children = [1, 2, 3, 4].map((n) => {
      const file = join(pages, `p${n}.txt`);
      writeFileSync(file, text(n));
      return new Promise<number | null>((done) => {
        spawn(process.execPath, [CLI, "ingest", "--run", dir, "--files", file], { stdio: "ignore" }).on("close", done);
      });
    });
    expect(await Promise.all(children)).toEqual([0, 0, 0, 0]);
    const { sources } = readDossier(dir);
    // Four more ids, each its own: without the lock two writers read the same
    // highest id and the last one to write keeps it.
    expect(sources.map((s) => s.id)).toEqual(Array.from({ length: gathered + 4 }, (_, i) => `S${i + 1}`));
    expect(new Set(sources.map((s) => s.url)).size).toBe(gathered + 4);
    expect(existsSync(lockOf(dir))).toBe(false);
  });

  it("the MCP server: a read or a dry run never waits on another process's lock, a write does", async () => {
    const dir = temp();
    await runGather(opts({ out: dir }));
    writeFileSync(lockOf(dir), holder(process.ppid));
    process.env.ULTRASEARCH_LOCK_WAIT_MS = "100";
    try {
      const t0 = Date.now();
      const write = callTool("ultrasearch_drop", { run: dir, ids: ["S1"] });
      // Sent while the write is waiting: answered at once, not after it.
      const dry = await callTool("ultrasearch_drop", { run: dir, ids: ["S1"], dry_run: true });
      const check = await callTool("ultrasearch_check", { run: dir });
      expect(Date.now() - t0).toBeLessThan(90);
      expect(JSON.parse(dry.text)).toBeDefined();
      expect(check.text).toBeDefined();
      await expect(write).rejects.toThrow(/is being written by another ultrasearch process/);
    } finally {
      delete process.env.ULTRASEARCH_LOCK_WAIT_MS;
    }
  });

  it("the CLI holds the lock for a writing command and not for a listing", async () => {
    const dir = temp();
    await runGather(opts({ out: dir }));
    writeFileSync(lockOf(dir), holder(process.pid));
    const env = { ...process.env, ULTRASEARCH_LOCK_WAIT_MS: "200" };
    // The holder is this test process: alive for the child, and never releasing.
    const writer = spawnSync(process.execPath, [CLI, "drop", "--run", dir, "--id", "S1"], { encoding: "utf8", env });
    expect(writer.status).toBe(1);
    expect(writer.stderr).toContain("waiting for another ultrasearch process to finish writing");
    expect(writer.stderr).toContain("is being written by another ultrasearch process");
    const reader = spawnSync(process.execPath, [CLI, "drop", "--run", dir, "--id", "S1", "--dry-run"], { encoding: "utf8", env });
    expect(reader.status).toBe(0);
    // A flag the command does not read changes nothing: this drop still drops, so it still waits.
    const stray = spawnSync(process.execPath, [CLI, "drop", "--run", dir, "--id", "S1", "--list"], { encoding: "utf8", env });
    expect(stray.status).toBe(1);
    expect(readDossier(dir).sources.map((s) => s.id)).toContain("S1");
    expect(spawnSync(process.execPath, [CLI, "check", "--run", dir], { encoding: "utf8", env }).stderr).not.toContain("waiting for another");
  });
});
