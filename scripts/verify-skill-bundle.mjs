#!/usr/bin/env node
// Install-bundle gate: prove the repo is shaped so that `npx skills add
// maxgfr/<name>` installs a WORKING skill — engine + references included, not
// just a lone SKILL.md.
//
// The `skills` CLI (skills.sh) early-returns the moment it sees a SKILL.md at
// the repository ROOT and then installs that file ALONE — the sibling
// scripts/ and references/ are dropped. A skill is only bundled whole when its
// SKILL.md lives in a SUBDIRECTORY (skills/<name>/). This script asserts that
// shape and that the embedded engine is byte-identical to the tested bundle.
//
// Run by CI and by `pnpm run verify:bundle`. Pure Node, no deps, no network.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Claude Code matches skill descriptions at <=1024 chars; 1000 leaves a safety
// margin so a future edit can't silently cross the cap.
const DESC_MAX = 1000;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const name = pkg.name;
const skillDir = join(root, "skills", name);
const errors = [];
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => {
  errors.push(m);
  console.log(`  FAIL ${m}`);
};

// 1. No SKILL.md at the repo root (would make `skills add` install it alone).
existsSync(join(root, "SKILL.md"))
  ? bad("a SKILL.md exists at the repo ROOT — `skills add` would install it alone, dropping the engine. Move it to skills/" + name + "/SKILL.md")
  : ok("no root SKILL.md");

// 2. The packaged SKILL.md exists with valid, installable frontmatter.
const skillMd = join(skillDir, "SKILL.md");
if (!existsSync(skillMd)) {
  bad(`missing ${skillMd} — the skill package has no SKILL.md`);
} else {
  const raw = readFileSync(skillMd, "utf8");
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fm) bad("skills/" + name + "/SKILL.md has no frontmatter block");
  else {
    ok("packaged SKILL.md present with frontmatter");
    const nameLine = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    nameLine === name ? ok(`frontmatter name "${name}" matches package`) : bad(`frontmatter name "${nameLine}" != package name "${name}"`);
    const desc = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (!desc) bad("frontmatter has no description");
    else {
      const len = desc.replace(/^["']|["']$/g, "").length;
      len <= DESC_MAX ? ok(`description ${len} chars (<= ${DESC_MAX} headroom cap)`) : bad(`description ${len} chars exceeds the ${DESC_MAX}-char headroom cap`);
    }
  }

  // 3. Every references/*.md mentioned exists, and every file is mentioned.
  const refsDir = join(skillDir, "references");
  if (existsSync(refsDir)) {
    const mentioned = new Set(raw.match(/references\/[a-z0-9-]+\.md/g) ?? []);
    for (const ref of mentioned) existsSync(join(skillDir, ref)) ? ok(`mentioned ${ref} exists`) : bad(`${ref} is mentioned in SKILL.md but missing from the package`);
    for (const f of readdirSync(refsDir).filter((f) => f.endsWith(".md"))) raw.includes(`references/${f}`) ? null : bad(`references/${f} exists but SKILL.md never mentions it`);
    ok(`references/ present (${readdirSync(refsDir).filter((f) => f.endsWith(".md")).length} playbooks)`);
  }
}

// 4. The embedded engine is byte-identical to the committed root bundle.
const engine = `scripts/${name}.mjs`;
const rootEngine = join(root, engine);
const pkgEngine = join(skillDir, engine);
if (!existsSync(rootEngine)) bad(`missing ${engine} at repo root — run \`pnpm run build\``);
else if (!existsSync(pkgEngine)) bad(`missing skills/${name}/${engine} — run \`node scripts/copy-bundle.mjs\``);
else readFileSync(rootEngine).equals(readFileSync(pkgEngine))
  ? ok(`embedded engine skills/${name}/${engine} is byte-identical to ${engine}`)
  : bad(`skills/${name}/${engine} differs from ${engine} — run \`node scripts/copy-bundle.mjs\` and commit`);

// 5. Docs ↔ CLI drift gate: every `--flag` the skill package documents must
// exist in the CLI, every CLI flag must be visible in `--help` (SKILL.md
// promises "run --help for the full surface"), and any `--web-engine` value
// enumeration in the docs must match the engine's list exactly. The bundle
// exports its flag tables for this; importing it is side-effect-free (the
// bundle's isInvokedDirectly() guards main()). A STALE bundle is caught
// upstream by check:build's git diff; a bundler that stops re-exporting is
// caught by the presence assert below; a doc legitimately quoting ANOTHER
// tool's flag goes in ALLOWED_FOREIGN_FLAGS.
if (existsSync(pkgEngine) && existsSync(skillMd)) {
  let cli = null;
  try {
    cli = await import(pathToFileURL(pkgEngine).href);
  } catch (e) {
    bad(`cannot import skills/${name}/${engine} for the drift gate: ${e.message}`);
  }
  if (cli && !(cli.VALUE_FLAGS && cli.BOOL_FLAGS && cli.HELP && cli.ALL_WEB_ENGINES)) {
    bad("the bundle no longer exports VALUE_FLAGS/BOOL_FLAGS/HELP/ALL_WEB_ENGINES — the drift gate needs them");
    cli = null;
  }
  if (cli) {
    const ALLOWED_FOREIGN_FLAGS = new Set([]); // flags belonging to other tools that the docs quote
    const cliFlags = new Set([...cli.VALUE_FLAGS, ...cli.BOOL_FLAGS]);
    const universe = new Set([...cliFlags, "help", "version", "h", "v", ...ALLOWED_FOREIGN_FLAGS]);
    const refs = join(skillDir, "references");
    const docs = [
      ["SKILL.md", readFileSync(skillMd, "utf8")],
      ...(existsSync(refs)
        ? readdirSync(refs)
            .filter((f) => f.endsWith(".md"))
            .map((f) => [`references/${f}`, readFileSync(join(refs, f), "utf8")])
        : []),
    ];

    // A. docs ⊆ CLI: a documented flag that the engine rejects is a doc bug.
    let unknown = 0;
    for (const [file, text] of docs) {
      for (const m of text.matchAll(/(?:^|[\s`("'\[])--([a-z][a-z0-9-]*)/gm)) {
        if (!universe.has(m[1])) {
          bad(`${file} documents unknown flag --${m[1]} (add it to ALLOWED_FOREIGN_FLAGS only if it belongs to another tool)`);
          unknown++;
        }
      }
    }
    if (!unknown) ok(`every --flag documented across ${docs.length} skill file(s) exists in the CLI`);

    // B. CLI ⊆ --help: SKILL.md tells agents --help is the full surface.
    // The lookahead stops --run matching only inside --run-root.
    const missing = [...cliFlags].filter((f) => !new RegExp(`--${f}(?![a-z0-9-])`).test(cli.HELP));
    missing.length === 0 ? ok("--help covers the whole flag surface") : bad(`--help omits: ${missing.map((f) => `--${f}`).join(", ")}`);

    // C. Any pipe-separated --web-engine value list in the docs matches the
    // engine's exact set (assertions A/B only police flag NAMES, not values).
    const want = [...cli.ALL_WEB_ENGINES].sort().join(", ");
    for (const [file, text] of docs) {
      for (const line of text.split("\n")) {
        if (!line.includes("--web-engine")) continue;
        const list = line.match(/((?:[a-z]{2,}\s*\|\s*){2,}[a-z]{2,})/);
        if (!list) continue;
        const got = list[1]
          .split("|")
          .map((s) => s.trim())
          .sort()
          .join(", ");
        got === want
          ? ok(`${file} --web-engine value list matches the engine`)
          : bad(`${file} lists --web-engine values [${got}] but the engine supports [${want}]`);
      }
    }
  }
}

if (errors.length) {
  console.error(`\nverify-skill-bundle: ${errors.length} problem(s) — the published skill would not install correctly.`);
  process.exit(1);
}
console.log(`\nverify-skill-bundle: ok — skills/${name}/ installs as a complete skill.`);
