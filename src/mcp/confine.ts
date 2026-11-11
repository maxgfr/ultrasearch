import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ToolError } from "../engine.js";
import { defaultRunDir } from "../gather.js";
import { runId } from "../util.js";

// An optional fence around the paths an MCP client may name.
//
// Without one, `run`, `out`, `master`, `run_root`, `runs` and refcheck's
// `refs` / `citing` accept any absolute path — the CLI's contract, and right
// for a server that is the user's own agent. With `ultrasearch mcp --root <dir>`
// (or ULTRASEARCH_MCP_ROOT) every one of them must resolve inside that
// directory, symlinks followed, so the server can be handed to a client that
// should not read or write the rest of the disk. A tool that would create its
// directory under the temp root creates it under the fence instead: a dossier
// the next call cannot reach would be no use.

/** The tools that operate on one existing dossier, and so fall back to `--run`. */
const RUN_TOOLS = new Set([
  "ultrasearch_fetch",
  "ultrasearch_ingest",
  "ultrasearch_check",
  "ultrasearch_relink",
  "ultrasearch_drop",
  "ultrasearch_verify",
  "ultrasearch_render",
  "ultrasearch_read",
]);

/** Whether a server's `--run` default lies outside its `--root`: refused at start. */
export function defaultRunOutside(root: string, defaultRun: string | undefined): boolean {
  return !!defaultRun && !inside(real(root), defaultRun);
}

/** The arguments that name a file or a directory, per kind. */
const PATH_ARGS = ["run", "out", "master", "run_root", "refs", "citing"] as const;
const PATH_LIST_ARGS = ["runs"] as const;

// A path is judged by where it really is: the nearest ancestor that exists is
// resolved through its symlinks, and what does not exist yet is appended. A
// link inside the fence pointing out of it is outside.
function real(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    tail.unshift(head.slice(up.length).replace(/^[\\/]/, ""));
    head = up;
  }
  let base = head;
  try {
    base = realpathSync(head);
  } catch {
    /* unreadable: judged as written */
  }
  return join(base, ...tail);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, real(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Check every path argument of a call against `root`, and give the tools that
 * create a directory by default one inside it. Returns the arguments to use;
 * throws a ToolError naming the argument and the root otherwise.
 */
export function confineArgs(name: string, args: Record<string, unknown>, root: string | undefined, defaultRun?: string): Record<string, unknown> {
  if (!root) return args;
  const fence = real(root);
  const out = { ...args };
  const refuse = (key: string, value: string): never => {
    throw new ToolError(`\`${key}\` (${value}) is outside the directory this server is confined to (${fence}).`);
  };
  // A relative path would be judged against the server's working directory,
  // which the client does not know and the fence does not cover: refused here,
  // before anything (a lock file included) is created from it.
  // A `..` segment is refused outright: the fence resolves a path's symlinks
  // after normalising it, while the OS walks `link/..` through the link — so
  // `<root>/link/../f` is judged as `<root>/f` and opened outside the root.
  const check = (key: string, v: string): void => {
    if (!isAbsolute(v)) throw new ToolError(`\`${key}\` must be an absolute path inside ${fence} (got "${v}").`);
    if (v.split(/[\\/]/).includes("..")) throw new ToolError(`\`${key}\` must not contain a \`..\` segment (got "${v}").`);
    if (!inside(fence, v)) refuse(key, v);
  };
  const blank = (key: string) => typeof out[key] !== "string" || !(out[key] as string).trim();
  for (const key of PATH_ARGS) if (!blank(key)) check(key, out[key] as string);
  for (const key of PATH_LIST_ARGS) {
    const v = out[key];
    if (Array.isArray(v)) for (const item of v) if (typeof item === "string") check(key, item);
  }
  // The operator's `--run` default is checked once, when the server starts
  // (see `defaultRunOutside`); this is the same check for a server built in
  // process. Only a tool that operates on a dossier falls back to it, and only
  // when `run` is left blank in any way (absent, null, "").
  if (defaultRun && RUN_TOOLS.has(name) && blank("run") && !inside(fence, defaultRun)) refuse("run (the server's --run default)", defaultRun);

  if (name === "ultrasearch_gather" && blank("out") && typeof out.question === "string") {
    const dir = defaultRunDir(typeof out.mode === "string" ? out.mode : "topic", out.question);
    out.out = join(fence, relative(join(tmpdir(), "ultrasearch"), dir));
  }
  if (name === "ultrasearch_merge" && blank("master")) out.master = join(fence, `merge-${runId()}`);
  if (name === "ultrasearch_refcheck" && blank("out")) out.out = join(fence, `refcheck-${runId()}`);
  if (name === "ultrasearch_brainstorm" && blank("out")) out.out = join(fence, `brainstorm-${runId()}`);
  return out;
}
