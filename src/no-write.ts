import { mkdirSync, writeFileSync } from "node:fs";

// The no-write gate.
//
// Every command worth running persists something: `gather` lays down a whole
// dossier directory, `render` an index.html/index.md pair, `brainstorm` a
// BRAINSTORM.md. That is the right default — the workflow is file-mediated, and
// the report tiers the model writes live beside the evidence it cites.
//
// It is also unusable in a read-only phase: a planning phase, a sandbox, any
// harness that forbids writes. There the caller wants one thing — real sources,
// read — and no report folder at all.
//
// So: one switch that every write in src/ passes through. Under it, an artifact
// is collected in memory instead of written, and the CLI streams what it would
// have written to stdout. The guarantee is a property of THIS module, not a
// promise each command has to keep individually — which is why even the writes
// belonging to commands that refuse to run in this mode (merge, fetch, verify,
// orchestrate) are routed here too.
//
// Note what this is NOT: a sandbox. It stops the writes ultrasearch performs; it
// cannot stop a caller from redirecting stdout into a file. The point is that a
// plain invocation leaves the filesystem exactly as it found it.

export interface Artifact {
  /** Path the artifact WOULD have been written to. */
  path: string;
  content: string;
}

// Set by the CLI from --stdout. The env var is checked separately on every call
// so a host can set it once (it is the only lever the MCP server has — it never
// parses CLI flags). Module state with a reset seam mirrors src/run-lock.ts.
let flagged = false;

export function setNoWrite(on: boolean): void {
  flagged = on;
}

export function isNoWrite(): boolean {
  return flagged || process.env.ULTRASEARCH_NO_WRITE === "1";
}

const collected: Artifact[] = [];

/** mkdirSync -p, or nothing at all under no-write. */
export function ensureDir(dir: string): void {
  if (isNoWrite()) return;
  mkdirSync(dir, { recursive: true });
}

/**
 * Write a file, or collect it under no-write. Returns the path either way — so
 * callers keep their existing shape — which means a caller that PRINTS the
 * returned path must check `isNoWrite()` first, or it advertises a file that
 * does not exist. The CLI does exactly that.
 */
export function writeArtifact(path: string, content: string): string {
  if (isNoWrite()) {
    // Last write wins, as on a real filesystem: `enrich` rewrites DOSSIER.md
    // after `gather` already produced one, and a stale copy in the stream would
    // contradict the fresh one.
    const at = collected.findIndex((a) => a.path === path);
    if (at !== -1) collected[at] = { path, content };
    else collected.push({ path, content });
    return path;
  }
  writeFileSync(path, content);
  return path;
}

/** Drain the collected artifacts. Empty when writes actually went to disk. */
export function takeArtifacts(): Artifact[] {
  return collected.splice(0, collected.length);
}

/** Test seam: clear both the switch and anything collected under it. */
export function resetNoWrite(): void {
  flagged = false;
  collected.length = 0;
}
