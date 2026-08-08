#!/usr/bin/env node
// Prove this skill actually uses the vendored engine — and cannot quietly
// re-fork it.
//
// The engine was extracted precisely because the same code lived in three
// repos. Nothing stopped it drifting back: for a while this repo vendored a
// bundle exporting the whole MCP transport while running its own 929-line copy
// beside it, and every gate was green. Counting imports would not have caught
// that either — the copy was imported too, just from the wrong place.
//
// So the check is a prohibition, not a tally:
//
//   No module under src/ may DECLARE a name the engine already exports.
//
// Re-exporting an engine name is fine and expected — that is what the shims do,
// and it is how `from "./util.js"` keeps working after the implementation
// moved. Declaring one is the regression: it means a second implementation of
// something the engine owns now exists in this tree, and imports will silently
// resolve to whichever the author happened to reach for.
//
// A floor on distinct imported symbols rides along, so deleting the last use of
// a layer is a decision someone has to make on purpose.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const vendorDts = join(srcDir, "vendor", "webindex-engine.d.mts");

// The engine's public surface, read from the vendored declarations rather than
// hardcoded — so this check follows the engine without anyone updating it.
function engineExports() {
  const dts = readFileSync(vendorDts, "utf8");
  const block = dts.match(/export\s*\{([\s\S]*?)\}\s*;?\s*$/);
  if (!block) {
    console.error("verify-engine-usage: could not find the export block in the vendored .d.mts");
    process.exit(1);
  }
  return new Set(
    block[1]
      .split(",")
      .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop())
      .filter(Boolean),
  );
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== "vendor") walk(p, out);
    } else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

// Forks that predate the engine and have NOT been adopted yet, with the reason.
// This is a ratchet: entries may leave, never arrive. A declaration that is not
// listed fails the build, so the next fork has to be an argued decision rather
// than a quiet copy.
//
// Read from a sibling JSON so the list is reviewable on its own in a diff.
function knownForks() {
  try {
    const raw = JSON.parse(readFileSync(join(root, "scripts", "engine-forks.json"), "utf8"));
    return new Map(Object.entries(raw.forks ?? {}));
  } catch {
    return new Map();
  }
}

const ENGINE = engineExports();
const FORKS = knownForks();
const files = walk(srcDir);

// `export function X` / `export const X` / `export class X` / `export interface X`
// / `export type X =`. Deliberately NOT `export { X } from "…"` or `export type
// { X } from "…"`, which are re-exports and are the whole point of the shims.
const DECL = /^export\s+(?:async\s+)?(?:function|const|let|class|interface|enum)\s+([A-Za-z_$][\w$]*)|^export\s+type\s+([A-Za-z_$][\w$]*)\s*=/gm;
// Both forms count as use. An `import` is this tree calling the engine; an
// `export … from` is this tree SERVING the engine's implementation under the
// path its own callers already use — which is what every shim does, and is the
// larger half of the usage. Counting only imports would report a repo that had
// successfully deleted its forks as barely using the engine at all.
const USES_ENGINE = /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"(?:\.\.\/)*engine\.js"/g;

const collisions = [];
const tolerated = [];
const imported = new Set();

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const rel = relative(root, f);

  for (const m of src.matchAll(DECL)) {
    const name = m[1] ?? m[2];
    if (!ENGINE.has(name)) continue;
    const allowed = FORKS.get(`${rel}:${name}`);
    if (allowed) tolerated.push({ rel, name, why: allowed });
    else collisions.push({ rel, name });
  }
  for (const m of src.matchAll(USES_ENGINE)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (name) imported.add(name);
    }
  }
}

// Raise this when a layer lands. Never lower it to make a red run pass — a drop
// means a layer stopped being used, which is a decision, not a detail.
const FLOOR = Number(process.env.ENGINE_USAGE_FLOOR ?? 75);

let ok = true;

if (collisions.length) {
  console.error(`verify-engine-usage: ${collisions.length} name(s) declared here that the engine already exports:\n`);
  for (const c of collisions) console.error(`  ${c.rel}  declares  ${c.name}`);
  console.error("\n  Re-export it from ./engine.js instead of declaring a second implementation.");
  console.error("  (A re-export — `export { X } from \"./engine.js\"` — is fine and is not flagged.)");
  ok = false;
}

if (imported.size < FLOOR) {
  console.error(`\nverify-engine-usage: only ${imported.size} distinct engine symbols are imported, floor is ${FLOOR}.`);
  console.error("  A layer stopped being used. If that was deliberate, lower the floor in the same commit.");
  ok = false;
}

// A listed fork that no longer exists is stale bookkeeping — the list must
// shrink as adoption lands, and an entry nobody can find hides that it did.
const seen = new Set(tolerated.map((t) => `${t.rel}:${t.name}`));
const stale = [...FORKS.keys()].filter((k) => !seen.has(k));
if (stale.length) {
  console.error(`verify-engine-usage: ${stale.length} entr(y|ies) in engine-forks.json no longer exist — delete them:`);
  for (const k of stale) console.error(`  ${k}`);
  ok = false;
}

if (ok) {
  const note = tolerated.length ? `, ${tolerated.length} known fork(s) still to adopt` : ", no local re-declarations";
  console.log(`verify-engine-usage: ${imported.size} engine symbols in use (floor ${FLOOR})${note}, of a ${ENGINE.size}-symbol surface.`);
}
process.exit(ok ? 0 : 1);
