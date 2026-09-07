import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyVerdicts, buildWorklist, runVerify } from "../src/verify.js";
import { runCheck } from "../src/check.js";
import { writeFixtureDossier } from "./dossierfix.js";

// The stale-ledger family: `check --semantic --require-verify` matched the
// adjudicated VERIFY.json against REPORT on (claimId, sourceId) ALONE. Rewriting
// a claim's meaning (or the extract it rests on) after `verify --apply` left the
// keys intact, so a "supported" verdict kept validating text nobody adjudicated.
// The gate must bind each verdict to the CONTENT it judged — the claim's text and
// the full cited extract — at worklist generation, at the fold, and at the gate.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-bind-"));
}

const CLAIM = "Rate limiting restricts requests to protect the server. [S1]";
const FLIPPED = "Rate limiting allows unlimited requests and never restricts clients. [S1]";
const REPORT = `# Rate limiting\n\n${CLAIM}\n`;
const EXTRACT = "# S1\nRate limiting restricts requests to protect the server.\nClients must slow down after exceeding the rate limit.\n";

function dossier(): string {
  const dir = scratch();
  writeFixtureDossier(dir, 1);
  writeFileSync(join(dir, "sources", "S1.md"), EXTRACT);
  writeFileSync(join(dir, "REPORT.md"), REPORT);
  return dir;
}

// The documented adjudication path: the agent fills VERIFY.todo.json's rows and
// saves them as verdicts.json — every derived field travels with the verdict.
function verdictsFromTodo(dir: string, verdict = "supported", name = "verdicts.json"): string {
  const todo = JSON.parse(readFileSync(join(dir, "VERIFY.todo.json"), "utf8"));
  const f = join(dir, name);
  writeFileSync(f, JSON.stringify({ pairs: todo.pairs.map((p: Record<string, unknown>) => ({ ...p, verdict, note: "adjudicated" })) }));
  return f;
}

// The minimal shape the orchestrate-emitted skeptic schema returns: keys +
// verdict + note, nothing derived.
function fragmentFromTodo(dir: string, verdict = "supported"): string {
  const todo = JSON.parse(readFileSync(join(dir, "VERIFY.todo.json"), "utf8"));
  const f = join(dir, "verdicts.0.json");
  writeFileSync(
    f,
    JSON.stringify({
      verdicts: todo.pairs.map((p: { claimId: string; sourceId: string }) => ({ claimId: p.claimId, sourceId: p.sourceId, verdict, note: "adjudicated" })),
    }),
  );
  return f;
}

const gate = (dir: string) => runCheck(dir, { semantic: true, requireVerify: true });
const digestOf = (dir: string) => buildWorklist(dir).worklist.pairs[0]!.extractDigest;

describe("verify/check content binding — the adjudicated worklist is bound to REPORT + extracts", () => {
  it("rejects a minimal fragment when its saved generation worklist is stale", () => {
    const dir = dossier();
    runVerify(dir);
    const file = fragmentFromTodo(dir);
    writeFileSync(join(dir, "REPORT.md"), FLIPPED);
    expect(() => applyVerdicts(dir, file)).toThrow(/changed since/i);
    expect(existsSync(join(dir, "VERIFY.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(["minimal", "legacy"])("rejects %s without a generation worklist after a claim suffix edit", (shape) => {
    const dir = dossier();
    const prefix = "Rate limiting protects the server. ".repeat(20);
    writeFileSync(join(dir, "REPORT.md"), `${prefix}Requests are restricted. [S1]`);
    runVerify(dir);
    const file = shape === "minimal" ? fragmentFromTodo(dir) : verdictsFromTodo(dir);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    for (const row of raw.pairs ?? raw.verdicts) delete row.fingerprint;
    writeFileSync(file, JSON.stringify(raw));
    rmSync(join(dir, "VERIFY.todo.json"));
    writeFileSync(join(dir, "REPORT.md"), `${prefix}Requests are unlimited. [S1]`);
    expect(() => applyVerdicts(dir, file)).toThrow(/unbound|generation|fingerprint/i);
    expect(existsSync(join(dir, "VERIFY.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a modern fingerprint without a saved todo", () => {
    const dir = dossier();
    runVerify(dir);
    const file = verdictsFromTodo(dir);
    rmSync(join(dir, "VERIFY.todo.json"));
    expect(applyVerdicts(dir, file).ok).toBe(true);
    expect(gate(dir).ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("binds minimal fragments from a saved shard and rejects stale shard evidence", () => {
    const dir = dossier();
    const todo = runVerify(dir, { shards: 2, shard: 0 });
    const file = join(dir, "fragment.json");
    writeFileSync(file, JSON.stringify(todo.pairs.map(({ claimId, sourceId }) => ({ claimId, sourceId, verdict: "supported" }))));
    expect(applyVerdicts(dir, file).ok).toBe(true);
    writeFileSync(join(dir, "sources", "S1.md"), `${EXTRACT}The rule has been withdrawn.`);
    expect(() => applyVerdicts(dir, file)).toThrow(/changed since/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("GREEN: the authentic verify → apply → gate flow passes", () => {
    const dir = dossier();
    runVerify(dir);
    expect(applyVerdicts(dir, verdictsFromTodo(dir)).ok).toBe(true);
    const r = gate(dir);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("RED: fails closed when REPORT's claim is flipped after `verify --apply` (stale-report exploit)", () => {
    const dir = dossier();
    runVerify(dir);
    applyVerdicts(dir, verdictsFromTodo(dir));
    expect(gate(dir).ok).toBe(true); // the adjudicated report passes
    // Same claim id, same [S1] — only the MEANING changed. The keys still match.
    writeFileSync(join(dir, "REPORT.md"), `# Rate limiting\n\n${FLIPPED}\n`);
    const r = gate(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/changed since/i);
    expect(r.errors.join(" ")).toMatch(/verify/);
    // The mechanical gate alone stays green — this is an additive exit-gate rule.
    expect(runCheck(dir).ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("RED: fails closed when the cited source extract is rewritten after `verify --apply`", () => {
    const dir = dossier();
    runVerify(dir);
    applyVerdicts(dir, verdictsFromTodo(dir));
    expect(gate(dir).ok).toBe(true);
    // REPORT untouched; the evidence under the claim is swapped out.
    writeFileSync(join(dir, "sources", "S1.md"), "# S1\nRate limiting was removed and no request is ever throttled.\n");
    const r = gate(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/changed since/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("RED: an extract edit BEYOND the digest prefix cannot evade the gate (full-source identity)", () => {
    const dir = dossier();
    // A long extract whose claim-relevant sentences all sit in the digest window.
    const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} discusses unrelated deployment topology matters at length.`).join("\n");
    writeFileSync(join(dir, "sources", "S1.md"), `${EXTRACT}${filler}\n`);
    runVerify(dir);
    applyVerdicts(dir, verdictsFromTodo(dir));
    expect(gate(dir).ok).toBe(true);
    const before = digestOf(dir);
    // Append past the 600-char digest window: the adjudicated snippet is byte-identical…
    writeFileSync(join(dir, "sources", "S1.md"), `${EXTRACT}${filler}\nGuidance in this section was withdrawn by the maintainers in 2026.\n`);
    expect(digestOf(dir)).toBe(before);
    // …yet the gate must still see the source it adjudicated is no longer this one.
    expect(gate(dir).ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("RED: `verify --apply` rejects verdicts generated before REPORT was edited", () => {
    const dir = dossier();
    runVerify(dir);
    const f = verdictsFromTodo(dir);
    writeFileSync(join(dir, "REPORT.md"), `# Rate limiting\n\n${FLIPPED}\n`);
    expect(() => applyVerdicts(dir, f)).toThrow(/changed since/i);
    // Fail-closed: no ledger is written, so no fresh fingerprint is stamped over
    // an adjudication that judged different text.
    expect(existsSync(join(dir, "VERIFY.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("RED: `verify --apply` rejects verdicts generated before the source extract was edited", () => {
    const dir = dossier();
    runVerify(dir);
    const f = verdictsFromTodo(dir);
    writeFileSync(join(dir, "sources", "S1.md"), "# S1\nRate limiting was removed and no request is ever throttled.\n");
    expect(() => applyVerdicts(dir, f)).toThrow(/changed since/i);
    expect(existsSync(join(dir, "VERIFY.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("RED: `verify --apply` rejects a legacy row whose claim text no longer matches the worklist", () => {
    const dir = dossier();
    runVerify(dir);
    // The shape the repro fixture's accepted.json carries: keys + the OLD claim
    // text, no fingerprints. REPORT already says something else.
    writeFileSync(join(dir, "REPORT.md"), `# Rate limiting\n\n${FLIPPED}\n`);
    const f = join(dir, "accepted.json");
    writeFileSync(f, JSON.stringify({ pairs: [{ claimId: "C1", sourceId: "S1", claim: CLAIM, verdict: "supported", note: "Source explicitly says so." }] }));
    expect(() => applyVerdicts(dir, f)).toThrow(/changed since/i);
    expect(existsSync(join(dir, "VERIFY.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("GREEN: a minimal skeptic fragment for the CURRENT worklist still folds and passes", () => {
    const dir = dossier();
    runVerify(dir);
    // {claimId, sourceId, verdict, note} only — the emitted schema's shape. It
    // carries nothing to contradict the current worklist, so the fold binds it.
    expect(applyVerdicts(dir, fragmentFromTodo(dir)).ok).toBe(true);
    expect(gate(dir).ok).toBe(true);
    // …and it is bound from then on: a later REPORT edit is still caught.
    writeFileSync(join(dir, "REPORT.md"), `# Rate limiting\n\n${FLIPPED}\n`);
    expect(gate(dir).ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("RED: fails closed on an unbound ledger, naming the regeneration step", () => {
    const dir = dossier();
    // A hand-written / pre-binding VERIFY.json: the keys line up with REPORT and
    // the verdict is `supported`, but nothing ties it to the text it judged.
    writeFileSync(
      join(dir, "VERIFY.json"),
      JSON.stringify({
        ok: true,
        pairs: 1,
        adjudicated: 1,
        supported: 1,
        partial: 0,
        refuted: 0,
        unsupported: 0,
        failures: [],
        unadjudicated: [],
        verdicts: [
          {
            claimId: "C1",
            file: "REPORT.md",
            sourceId: "S1",
            claim: CLAIM,
            extractPath: "sources/S1.md",
            extractDigest: "",
            verdict: "supported",
            note: "legacy",
          },
        ],
      }),
    );
    const r = gate(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/verify --apply/);
    rmSync(dir, { recursive: true, force: true });
  });
});
