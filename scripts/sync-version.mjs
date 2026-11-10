#!/usr/bin/env node
// Sync the release version across the three places it lives, then let the
// caller rebuild the bundle. Invoked by
// @semantic-release/exec (prepareCmd):  node scripts/sync-version.mjs <version>
//
// The version is duplicated in package.json, src/types.ts (the value the bundle
// embeds) and SKILL.md frontmatter; semantic-release computes it from the
// Conventional Commits, so this keeps all three in lockstep. CHANGELOG.md is
// owned by @semantic-release/changelog, which writes the generated release
// notes before @semantic-release/git commits the bump — so it is NOT touched here.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
  console.error(`sync-version: expected a semver version, got "${version ?? ""}"`);
  process.exit(1);
}

const EDITS = [
  // package.json — the top-level "version" field.
  ["package.json", /("version":\s*")[^"]+(")/, `$1${version}$2`],
  // src/types.ts — the VERSION constant the CLI/bundle reports.
  ["src/types.ts", /(export const VERSION = ")[^"]+(";)/, `$1${version}$2`],
  // skills/ultrasearch/SKILL.md — the indented `version:` under the frontmatter
  // `metadata:` block. The skill is packaged in a subdirectory (not the repo
  // root) so `npx skills add` bundles the engine + references with it.
  ["skills/ultrasearch/SKILL.md", /(\n[ \t]+version:[ \t]*)[^\n]+/, `$1${version}`],
];

// A pattern that stops matching must stop the release: a warning here was a
// release shipping with the previous version still in the bundle or SKILL.md.
// All three are checked before any is written, so a failure leaves them in
// step. Matching without changing anything is fine — the version was already set.
const files = EDITS.map(([path, pattern, replacement]) => ({ path, pattern, replacement, before: readFileSync(path, "utf8") }));
const unmatched = files.filter((f) => !f.pattern.test(f.before));
if (unmatched.length) {
  for (const f of unmatched) console.error(`sync-version: no version found in ${f.path} (looked for ${f.pattern})`);
  console.error("sync-version: nothing was written");
  process.exit(1);
}
for (const f of files) writeFileSync(f.path, f.before.replace(f.pattern, f.replacement));

console.log(`sync-version: set ${version} in package.json, src/types.ts, skills/ultrasearch/SKILL.md`);
