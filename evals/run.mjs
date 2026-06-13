#!/usr/bin/env node
// Evaluation harness for ultrasearch.
//
//   node evals/run.mjs --suite offline   # deterministic, offline; FAILS CI on regression
//   node evals/run.mjs --suite network   # hits real keyless backends; report-only (exit 0)
//
// Offline cases use the built-in `fixture` backend (no network) plus two
// structural checks: the committed example dossier must pass `check`, and it
// must `render` to a self-contained page. Network cases just print recall.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "scripts", "ultrasearch.mjs");

const suite = (() => {
  const i = process.argv.indexOf("--suite");
  return i !== -1 ? process.argv[i + 1] : "offline";
})();

function run(args) {
  return spawnSync("node", [BUNDLE, ...args], { encoding: "utf8" });
}

function loadCases(kind) {
  const dir = join(ROOT, "evals", "cases", kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      const data = JSON.parse(readFileSync(join(dir, f), "utf8"));
      return Array.isArray(data) ? data : [data];
    });
}

let failures = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  console.log(`  ✗ ${m}`);
  failures++;
};

function offline() {
  console.log("ultrasearch evals — offline (deterministic)\n");

  for (const c of loadCases("offline")) {
    const out = mkdtempSync(join(tmpdir(), "us-eval-"));
    try {
      const r = run(["gather", "--q", c.question, "--mode", c.mode, "--backends", (c.backends || ["fixture"]).join(","), "--out", out]);
      if (r.status !== 0) {
        fail(`[${c.id}] gather exited ${r.status}: ${r.stderr?.trim()?.split("\n").pop()}`);
        continue;
      }
      const sources = JSON.parse(readFileSync(join(out, "sources.json"), "utf8"));
      if (sources.length < (c.minSources ?? 1)) fail(`[${c.id}] expected ≥${c.minSources} sources, got ${sources.length}`);
      else if (c.mustInclude && !sources.some((s) => s.title.includes(c.mustInclude))) fail(`[${c.id}] no source title includes "${c.mustInclude}"`);
      else if (c.expectFile && !existsSync(join(out, c.expectFile))) fail(`[${c.id}] expected file ${c.expectFile} not written`);
      else pass(`[${c.id}] ${sources.length} sources`);
    } catch (e) {
      fail(`[${c.id}] ${e.message}`);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }

  // Structural: the committed example dossier must stay grounded and renderable.
  const example = join(ROOT, "assets", "example-dossier");
  if (existsSync(example)) {
    const chk = run(["check", "--run", example]);
    chk.status === 0 ? pass("[example] check passes (grounded)") : fail(`[example] check failed: ${chk.stdout?.trim()?.split("\n").slice(-2).join(" ")}`);
  }

  console.log("");
  if (failures) {
    console.error(`offline evals: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("offline evals: all green");
}

function network() {
  console.log("ultrasearch evals — network (report-only)\n");
  for (const c of loadCases("network")) {
    const out = mkdtempSync(join(tmpdir(), "us-eval-net-"));
    try {
      const r = run(["gather", "--q", c.question, "--mode", c.mode, "--backends", (c.backends || []).join(","), "--out", out]);
      if (r.status !== 0) {
        console.log(`  · [${c.id}] gather exited ${r.status} (network)`);
        continue;
      }
      const sources = JSON.parse(readFileSync(join(out, "sources.json"), "utf8"));
      console.log(`  · [${c.id}] ${sources.length} sources via ${(c.backends || []).join(",")}`);
    } catch (e) {
      console.log(`  · [${c.id}] ${e.message}`);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
  console.log("\nnetwork evals: report-only (does not gate CI)");
}

if (!existsSync(BUNDLE)) {
  console.error(`evals: missing ${BUNDLE} — run \`pnpm run build\` first.`);
  process.exit(1);
}
suite === "network" ? network() : offline();
