import { spawn } from "node:child_process";

// Run an external extractor with the PDF on stdin and its text on stdout.
//
// stdin/stdout rather than a temp file: every tool in the ladder supports `-`,
// and it keeps this dependency-free module from having to manage (and clean up)
// files. `node:child_process` is built into Node, so nothing enters package.json.
//
// A separate process is also what makes an external extractor SAFE to use: it
// cannot take the run down with it. That matters — the WASM build of
// pdf-inspector reproducibly crashes V8's background wasm compiler
// ("Fatal process out of memory: Zone"), which would kill a whole research run
// from inside the process. A child that dies is just a rung that failed.

export interface RunResult {
  ok: boolean;
  stdout: string;
  /** Short cause when `ok` is false: "not installed", "timed out", "exit 2"… */
  error?: string;
}

// stdout is capped so a pathological tool can't balloon memory — the built-in
// reader has been observed emitting 16 MB of garbage for a 12 MB PDF, and an
// external one could do the same.
const MAX_STDOUT_BYTES = 24 * 1024 * 1024;

/** Windows ships npx as a .cmd shim, which `spawn` won't resolve on its own. */
export function binaryName(name: string): string {
  return process.platform === "win32" && name === "npx" ? "npx.cmd" : name;
}

/**
 * Spawn `cmd args…`, write `input` to its stdin, resolve with its stdout.
 * Never throws and never leaves a child behind: a missing binary, a non-zero
 * exit and a timeout all come back as `{ ok: false, error }`.
 */
export function runWithInput(cmd: string, args: string[], input: Buffer, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binaryName(cmd), args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, stdout: "", error: (e as Error).message });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, stdout: "", error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      if (size >= MAX_STDOUT_BYTES) return;
      size += d.length;
      chunks.push(d);
    });
    // Drain stderr so a chatty tool can't deadlock on a full pipe. We don't
    // report it: every failure here is already described by exit code or errno.
    child.stderr?.on("data", () => {});

    child.on("error", (e: NodeJS.ErrnoException) => {
      done({ ok: false, stdout: "", error: e.code === "ENOENT" ? "not installed" : e.message });
    });

    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).subarray(0, MAX_STDOUT_BYTES).toString("utf8");
      if (code === 0) done({ ok: true, stdout });
      else done({ ok: false, stdout, error: `exit ${code}` });
    });

    // EPIPE is normal here: a tool that rejects the input closes stdin early.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}
