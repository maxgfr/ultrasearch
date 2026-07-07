// Single source of truth for the doc↔CLI drift-gate patterns, shared by the
// artifact-layer gate (scripts/verify-skill-bundle.mjs, over the BUILT bundle)
// and the source-layer twin (tests/cli.test.ts + tests/skill-md.test.ts, over
// src/). Before this, the same regexes lived in both and were "kept in sync" by
// comments; centralizing them means a change lands in exactly one place.

// A fresh global regex matching a documented `--flag`. The lookbehind skips a
// `--` glued to a word tail (foo--bar, ---) so bold/parenthesised/em-dashed
// flags are still seen. Returns a NEW regex each call (global regexes are
// stateful via lastIndex — never share one).
export function docFlagRegex() {
  return /(?<![a-z0-9-])--([a-z][a-z0-9-]*)/g;
}

// Whether `help` mentions `--flag` as a whole token. The lookahead stops --run
// from matching only inside --run-root (and --shard inside --shards).
export function helpCoversFlag(help, flag) {
  return new RegExp(`--${flag}(?![a-z0-9-])`).test(help);
}

// The pipe-separated `--web-engine` value list on a line, as an array of engine
// names, or null if the line carries no such enumeration. The list must directly
// follow the flag (only non-letters between), so a markdown-table pipe elsewhere
// can't false-positive; backticks are stripped first so `a`|`b` still matches.
export function webEngineEnum(line) {
  const m = line.replace(/`/g, "").match(/--web-engine[^a-z|]*((?:[a-z][a-z0-9-]*\s*\|\s*)+[a-z][a-z0-9-]*)/);
  return m ? m[1].split("|").map((s) => s.trim()) : null;
}
