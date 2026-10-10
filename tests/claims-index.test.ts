import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexColumnRows, noNumeralsMask, unitsOfFile } from "../src/claims.js";
import { runCheck } from "../src/check.js";
import { buildWorklist } from "../src/verify.js";
import { writeFixtureDossier } from "./dossierfix.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-claims-index-"));
}

// The incident: a verification report whose table listed the thesis's reference
// numbers in its first column — 16 "numeral not in S#" warnings, all of them on
// "15", "18", "19"…, none on a claim.
const REF_TABLE = [
  "# Verification",
  "",
  "| Réf. | Claim | Verdict |",
  "|---|---|---|",
  "| 15 | The cohort enrolled 42 eyes followed for two years [S1] | supported |",
  "| 18 | Mean endothelial loss reached 9.5 percent at one year [S1] | supported |",
  "| 19 | Dislocation recurred in 3 eyes after the second surgery [S1] | partial |",
  "",
].join("\n");

describe("index columns", () => {
  it("drops a reference-number column named by its header", () => {
    const lines = REF_TABLE.split("\n");
    expect(
      indexColumnRows(
        lines,
        lines.map(() => false),
      ),
    ).toEqual([false, false, false, false, true, true, true, false]);
    const texts = unitsOfFile(REF_TABLE).map((u) => (u.kind === "text" ? u.text : ""));
    expect(texts[0]).toMatch(/^The cohort enrolled 42 eyes/);
    expect(texts.join(" ")).not.toMatch(/\b(15|18|19)\b/);
  });

  it("drops an unnamed first column holding only short running numbers", () => {
    const md = ["| n | Finding |", "|---|---|", "| 1 | Raft elects one leader per term [S1] |", "| 2 | Paxos agrees on a single value [S1] |"].join("\n");
    const texts = unitsOfFile(md).map((u) => (u.kind === "text" ? u.text : ""));
    expect(texts).toEqual(["Raft elects one leader per term [S1]", "Paxos agrees on a single value [S1]"]);
  });

  it("keeps a first column of years, of words, or a lone numbered row", () => {
    const years = ["| Year | Event |", "|---|---|", "| 2019 | First release [S1] |", "| 2021 | Second release [S1] |"].join("\n");
    expect(unitsOfFile(years).map((u) => (u.kind === "text" ? u.text : ""))[0]).toBe("2019 First release [S1]");
    const words = ["| Tool | Note |", "|---|---|", "| curl | fetches [S1] |", "| 7 | odd row [S1] |"].join("\n");
    expect(unitsOfFile(words).map((u) => (u.kind === "text" ? u.text : ""))[1]).toBe("7 odd row [S1]");
    const lone = ["| k | v |", "|---|---|", "| 3 | three things [S1] |"].join("\n");
    expect(unitsOfFile(lone).map((u) => (u.kind === "text" ? u.text : ""))[0]).toBe("3 three things [S1]");
  });

  // Audit: any small-integer first column was dropped — a data column too.
  it("keeps a first column of small data values that do not run", () => {
    const md = ["| Eyes | Outcome |", "|---|---|", "| 41 | operated with two pockets [S1] |", "| 39 | followed four years [S1] |"].join("\n");
    expect(unitsOfFile(md).map((u) => (u.kind === "text" ? u.text : ""))).toEqual(["41 operated with two pockets [S1]", "39 followed four years [S1]"]);
    const header = ["| # | Outcome |", "|---|---|", "| 4 | first [S1] |", "| 2 | second [S1] |"].join("\n");
    expect(unitsOfFile(header).map((u) => (u.kind === "text" ? u.text : ""))).toEqual(["first [S1]", "second [S1]"]);
  });

  it("no longer reports the index column as unattributed numerals", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    writeFileSync(
      join(dir, "sources/S1.md"),
      "# S1\nThe cohort enrolled 42 eyes. Mean endothelial loss reached 9.5 percent. Dislocation recurred in 3 eyes.\n",
    );
    writeFileSync(join(dir, "REPORT.md"), REF_TABLE);
    const r = runCheck(dir);
    expect(r.numeralIssues).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("<!-- ultrasearch:no-numerals -->", () => {
  it("ignores the annotation inside a code fence", () => {
    const raw = ["```markdown", "<!-- ultrasearch:no-numerals -->", "```", "", "The cohort had 7777 eyes [S1]."];
    expect(noNumeralsMask(raw)).toEqual([false, false, false, false, false]);
    const units = unitsOfFile(raw.join("\n"));
    expect(units.find((u) => u.kind === "text" && u.text.includes("7777"))?.noNumerals).toBeUndefined();
  });

  it("masks the block after the comment, or the block it sits in", () => {
    const raw = ["Intro line.", "", "<!-- ultrasearch:no-numerals -->", "", "| a | b |", "|---|---|", "| 1999 | x |", "", "Last 42 line."];
    expect(noNumeralsMask(raw)).toEqual([false, false, false, false, true, true, true, false, false]);
    const inline = ["First line of a paragraph,", "second line <!-- ultrasearch:no-numerals -->", "", "Next."];
    expect(noNumeralsMask(inline)).toEqual([true, true, false, false]);
  });

  it("exempts the annotated block from check and verify, and only that block", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    writeFileSync(join(dir, "sources/S1.md"), "# S1\nRate limiting caps how many requests a client may make.\n");
    writeFileSync(
      join(dir, "REPORT.md"),
      [
        "# Report",
        "",
        "<!-- ultrasearch:no-numerals -->",
        "The appendix table numbers 2017 and 2023 are page labels, not figures anyone claims [S1].",
        "",
        "Rate limiting caps requests at 5000 per minute for every single client [S1].",
        "",
      ].join("\n"),
    );
    const r = runCheck(dir);
    expect(r.numeralIssues?.map((n) => n.numeral)).toEqual(["5000"]);
    const units = unitsOfFile("<!-- ultrasearch:no-numerals -->\nA 2017 label [S1].");
    expect(units[0]).toMatchObject({ kind: "text", noNumerals: true });
    const wl = buildWorklist(dir);
    expect(wl.worklist.pairs.map((p) => p.numeralsAbsent ?? [])).toEqual([[], ["5000"]]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags lists and blockquotes under the comment too", () => {
    const md = ["<!-- ultrasearch:no-numerals -->", "- item 12 [S1]", "- item 13 [S1]", "", "<!-- ultrasearch:no-numerals -->", "> quoted 99 [S1]"].join("\n");
    const units = unitsOfFile(md);
    expect(units).toEqual([
      { kind: "list", items: ["item 12 [S1]", "item 13 [S1]"], noNumerals: true },
      { kind: "text", text: "quoted 99 [S1]", noNumerals: true },
    ]);
  });
});
