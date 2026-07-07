import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readDossier } from "../src/dossier.js";
import { runVerify, applyVerdicts } from "../src/verify.js";
import { runMerge } from "../src/merge.js";
import { addSource } from "../src/enrich.js";
import { writeFixtureDossier } from "./dossierfix.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-parse-"));
}

// P0.3 — a corrupt dossier artifact must surface a clean, file-naming error
// (turned into `ultrasearch: <msg>` + exit 1 by main().catch), never a raw
// SyntaxError with a stack trace.
describe("parse-error hardening (readJson)", () => {
  it("readDossier names sources.json when it is not valid JSON", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    writeFileSync(join(dir, "sources.json"), "{ not json");
    expect(() => readDossier(dir)).toThrow(/sources\.json is not valid JSON/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("readDossier names manifest.json when it is not valid JSON", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    writeFileSync(join(dir, "manifest.json"), "nope");
    expect(() => readDossier(dir)).toThrow(/manifest\.json is not valid JSON/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("runVerify names sources.json when it is corrupt", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    writeFileSync(join(dir, "REPORT.md"), "# R\nA grounded claim about token buckets and windows here [S1].");
    writeFileSync(join(dir, "sources.json"), "}{");
    expect(() => runVerify(dir)).toThrow(/sources\.json is not valid JSON/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("applyVerdicts names the verdicts file when it is corrupt", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    writeFileSync(join(dir, "REPORT.md"), "# R\nA grounded claim about token buckets and windows here [S1].");
    runVerify(dir);
    const bad = join(dir, "verdicts.json");
    writeFileSync(bad, "{ pairs: oops");
    expect(() => applyVerdicts(dir, bad)).toThrow(/verdicts file is not valid JSON/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("merge names the corrupt sub-dossier's sources.json", () => {
    const dir = scratch();
    const sub = join(dir, "q1");
    writeFixtureDossier(sub, 2);
    writeFileSync(join(sub, "sources.json"), "not json at all");
    expect(() => runMerge({ runs: [sub], master: join(dir, "master") })).toThrow(/sources\.json is not valid JSON/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("addSource names a corrupt manifest.json", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    writeFileSync(join(dir, "manifest.json"), "{bad");
    await expect(addSource(dir, "https://example.test/new")).rejects.toThrow(/manifest\.json is not valid JSON/);
    rmSync(dir, { recursive: true, force: true });
  });
});
