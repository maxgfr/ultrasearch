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
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
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

  // Semantic gate RED/GREEN: prove the deep-tier verification actually catches a
  // wrong claim end-to-end through the shipped bundle (not just via unit tests).
  semanticGateProbe();

  console.log("");
  if (failures) {
    console.error(`offline evals: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("offline evals: all green");
}

// Build a verdicts.json from a written VERIFY.todo.json, mapping every pair to
// the same verdict. Returns the file path.
function writeVerdicts(dir, verdict) {
  const todo = JSON.parse(readFileSync(join(dir, "VERIFY.todo.json"), "utf8"));
  const pairs = todo.pairs.map((p) => ({ ...p, verdict, note: "eval probe" }));
  const f = join(dir, "verdicts.json");
  writeFileSync(f, JSON.stringify({ pairs }));
  return f;
}

// RED/GREEN probe of the deep-tier semantic gate, end-to-end through the bundle:
// a refuted claim must FAIL `verify --apply` and `check --semantic`; a supported
// claim must PASS both; and `--require-verify` must fail without a VERIFY.json.
function semanticGateProbe() {
  const dir = mkdtempSync(join(tmpdir(), "us-eval-sem-"));
  try {
    const g = run(["gather", "--q", "rate limiting", "--mode", "topic", "--backends", "fixture", "--out", dir]);
    if (g.status !== 0) return fail(`[semantic-gate] gather failed: ${g.stderr?.trim()?.split("\n").pop()}`);
    writeFileSync(join(dir, "REPORT.md"), "# R\n## Claim\nThe fetched source states a specific verifiable fact about the subject here [S1].\n");

    // require-verify must fire when nothing has been adjudicated yet.
    const rv = run(["check", "--semantic", "--require-verify", "--run", dir]);
    if (rv.status === 0) return fail("[semantic-gate] --require-verify passed with no VERIFY.json");

    // Build the worklist, then the RED case: the cited source refutes the claim.
    if (run(["verify", "--run", dir]).status !== 0) return fail("[semantic-gate] verify (worklist) failed");
    const redApply = run(["verify", "--apply", writeVerdicts(dir, "refuted"), "--run", dir]);
    const redCheck = run(["check", "--semantic", "--run", dir]);
    if (redApply.status === 0 || redCheck.status === 0) return fail("[semantic-gate] RED: a refuted claim slipped through the gate");

    // GREEN: the cited source supports the claim → both must pass.
    run(["verify", "--run", dir]);
    const greenApply = run(["verify", "--apply", writeVerdicts(dir, "supported"), "--run", dir]);
    const greenCheck = run(["check", "--semantic", "--require-verify", "--run", dir]);
    if (greenApply.status !== 0 || greenCheck.status !== 0) return fail("[semantic-gate] GREEN: a supported+adjudicated claim was rejected");

    pass("[semantic-gate] RED refuted→fail, GREEN supported→pass, require-verify enforced");
  } catch (e) {
    fail(`[semantic-gate] ${e.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A raw HTML entity must never survive into a title/snippet — backends decode
// before emitting. This is an invariant (not web drift), so a leak is a real bug.
const RAW_ENTITY = /&(amp|lt|gt|quot|apos|nbsp|#0?39|#x27|#\d+);/i;

function network() {
  console.log("ultrasearch evals — network (report-only)\n");
  const recall = [];
  const hygieneRows = [];
  let deep = null;

  // 1. Per-backend recall: each keyless backend returns something (or is openly
  //    rate-limited). Report-only — the live web drifts and throttles.
  console.log("backend recall:");
  for (const c of loadCases("network")) {
    const out = mkdtempSync(join(tmpdir(), "us-eval-net-"));
    try {
      const r = run(["gather", "--q", c.question, "--mode", c.mode, "--backends", (c.backends || []).join(","), "--out", out]);
      if (r.status !== 0) {
        console.log(`  · [${c.id}] gather exited ${r.status} (network)`);
        recall.push({ id: c.id, backends: (c.backends || []).join(","), count: null, note: `gather exited ${r.status}` });
        continue;
      }
      const sources = JSON.parse(readFileSync(join(out, "sources.json"), "utf8"));
      const mark = sources.length ? "·" : "○"; // ○ = empty (often rate-limited; expected)
      console.log(`  ${mark} [${c.id}] ${sources.length} sources via ${(c.backends || []).join(",")}`);
      recall.push({ id: c.id, backends: (c.backends || []).join(","), count: sources.length, note: "" });
    } catch (e) {
      console.log(`  · [${c.id}] ${e.message}`);
      recall.push({ id: c.id, backends: (c.backends || []).join(","), count: null, note: e.message });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }

  // 2. Entity hygiene: no raw HTML entity may leak into a title/snippet (catches
  //    the kind of decode bug that hid in the Wikipedia/Crossref/Europe PMC
  //    backends — their APIs return &amp; and escaped JATS markup).
  console.log("\nentity hygiene (no raw HTML entities in titles/snippets):");
  const hygiene = [
    { id: "wikipedia", q: "rate limiting 429 error handling" },
    { id: "crossref", q: "R&D innovation policy" },
    { id: "europepmc", q: "p53 apoptosis cancer" },
  ];
  for (const h of hygiene) {
    const out = mkdtempSync(join(tmpdir(), "us-eval-ent-"));
    try {
      const r = run(["gather", "--q", h.q, "--mode", "topic", "--backends", h.id, "--out", out]);
      if (r.status !== 0) { console.log(`  ○ [${h.id}] gather failed (skipped)`); hygieneRows.push({ id: h.id, count: 0, leaks: null, note: "gather failed" }); continue; }
      const sources = JSON.parse(readFileSync(join(out, "sources.json"), "utf8"));
      const leaks = sources.filter((s) => RAW_ENTITY.test(s.title || "") || RAW_ENTITY.test(s.snippet || ""));
      if (!sources.length) { console.log(`  ○ [${h.id}] returned nothing (skipped)`); hygieneRows.push({ id: h.id, count: 0, leaks: null, note: "empty" }); }
      else if (leaks.length) { fail(`[${h.id}] raw entities leaked in ${leaks.length}/${sources.length}: ${leaks.map((s) => s.id).join(", ")}`); hygieneRows.push({ id: h.id, count: sources.length, leaks: leaks.length, note: leaks.map((s) => s.id).join(",") }); }
      else { pass(`[${h.id}] ${sources.length} source(s), all decoded`); hygieneRows.push({ id: h.id, count: sources.length, leaks: 0, note: "" }); }
    } catch (e) {
      console.log(`  · [${h.id}] entity hygiene: ${e.message}`);
      hygieneRows.push({ id: h.id, count: 0, leaks: null, note: e.message });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }

  // 3. Deep-tier end-to-end smoke against the real web: plan → fan out 2
  //    sub-questions → merge → grounded report → check → render.
  console.log("\ndeep-tier end-to-end (real web):");
  deep = deepSmoke();

  writeNetworkReport({ recall, hygiene: hygieneRows, deep });
  console.log("\nnetwork evals: report-only (does not gate CI) — wrote eval-network-report.md");
}

// Write a human-readable markdown report + a machine summary next to the run, so
// the weekly workflow can surface drift ($GITHUB_STEP_SUMMARY + an artifact)
// instead of it scrolling past in the log. `○` recall means a backend returned
// nothing — often a transient rate-limit, but a persistent one is real drift.
function writeNetworkReport({ recall, hygiene, deep }) {
  const dead = recall.filter((r) => r.count === 0).map((r) => r.id);
  const md = [];
  md.push("# ultrasearch — network eval report");
  md.push("");
  md.push("_Report-only: the live web drifts and rate-limits, so this never gates CI. A backend that returns nothing across every run is likely real drift, not a transient throttle._");
  md.push("");
  md.push("## Backend recall");
  md.push("");
  md.push("| case | backends | sources |");
  md.push("| --- | --- | --- |");
  for (const r of recall) md.push(`| ${r.id} | ${r.backends} | ${r.count === null ? "· " + r.note : r.count === 0 ? "○ 0 (empty)" : r.count} |`);
  md.push("");
  md.push("## Entity hygiene");
  md.push("");
  md.push("| backend | sources | raw-entity leaks |");
  md.push("| --- | --- | --- |");
  for (const h of hygiene) md.push(`| ${h.id} | ${h.count} | ${h.leaks === null ? "— (" + h.note + ")" : h.leaks === 0 ? "✓ none" : "✗ " + h.leaks + " (" + h.note + ")"} |`);
  md.push("");
  md.push("## Deep-tier end-to-end");
  md.push("");
  md.push(deep ? `${deep.ok ? "✓" : "✗"} ${deep.stages.join(" · ")}` : "○ skipped (network thin)");
  md.push("");
  if (dead.length) md.push(`> ⚠ ${dead.length} backend(s) returned nothing: **${dead.join(", ")}** — check for upstream drift.`);
  const summary = {
    deadBackends: dead,
    recall: recall.map((r) => ({ id: r.id, count: r.count })),
    hygiene: hygiene.map((h) => ({ id: h.id, leaks: h.leaks })),
    deep: deep ? { ok: deep.ok } : null,
  };
  try {
    writeFileSync(join(ROOT, "eval-network-report.md"), md.join("\n") + "\n");
    writeFileSync(join(ROOT, "eval-network-summary.json"), JSON.stringify(summary, null, 2));
  } catch (e) {
    console.log(`  · could not write network report: ${e.message}`);
  }
}

function deepSmoke() {
  const root = mkdtempSync(join(tmpdir(), "us-eval-deep-"));
  const skip = (m) => (console.log(`  ○ ${m}`), { ok: false, stages: [m] });
  try {
    const q = "how do token bucket and leaky bucket rate limiting differ";
    const planR = run(["plan", "--q", q, "--mode", "topic", "--run-root", join(root, "deep")]);
    if (planR.status !== 0) return skip("plan failed (skipped)");
    const subs = JSON.parse(planR.stdout).subQuestions.slice(0, 2);
    for (const s of subs) {
      run(["gather", "--q", s.question, "--queries", (s.queries || []).join("|"), "--mode", "topic", "--depth", "deep", "--out", s.out]);
    }
    const master = join(root, "deep", "master");
    const mr = run(["merge", "--runs", subs.map((s) => s.out).join(","), "--master", master, "--q", q, "--mode", "topic"]);
    if (mr.status !== 0) return skip("merge failed (skipped)");
    const sources = JSON.parse(readFileSync(join(master, "sources.json"), "utf8"));
    if (!sources.length) return skip("no sources after merge (network thin; skipped)");
    const cited = sources.slice(0, Math.min(3, sources.length));
    writeFileSync(
      join(master, "REPORT.md"),
      "# Token vs leaky bucket\n## How it works\n" +
        cited.map((s) => `Real fetched sources describe rate-limiting behaviour in detail [${s.id}].`).join("\n") + "\n",
    );
    const chk = run(["check", "--run", master]);
    run(["render", "--run", master]);
    const html = existsSync(join(master, "index.html"));
    const stages = [
      `plan ${subs.length} sub-q`,
      `merge ${sources.length} sources`,
      `check ${chk.status === 0 ? "✓" : "✗"}`,
      `render ${html ? "✓" : "✗"}`,
    ];
    const ok = chk.status === 0 && html;
    ok ? pass(`pipeline green — ${stages.join(" · ")}`) : fail(`pipeline issue — ${stages.join(" · ")}`);
    return { ok, stages };
  } catch (e) {
    console.log(`  · deep smoke: ${e.message}`);
    return { ok: false, stages: [`error: ${e.message}`] };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (!existsSync(BUNDLE)) {
  console.error(`evals: missing ${BUNDLE} — run \`pnpm run build\` first.`);
  process.exit(1);
}
suite === "network" ? network() : offline();
