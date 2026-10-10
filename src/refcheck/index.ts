// `ultrasearch refcheck` — check a bibliography the way a careful reviewer
// would: does each reference exist, are its metadata right, is it cited, and
// does the sentence citing it say what its abstract says?
//
// One pass covers what took three sub-agents by hand on a real thesis:
//   1. parse the numbered list (text, .docx, .pdf) or a .bib;
//   2. resolve each reference — PMID via E-utilities (its own id, ecitmatch,
//      its DOI, a title search), else Crossref — and check every cited DOI on
//      doi.org;
//   3. diff authors / title / NLM journal / year / volume / issue / pages / DOI
//      field by field against the record;
//   4. read the citing text: orphan references, calls with no reference,
//      Vancouver first-citation order, and every figure a citing sentence
//      states, looked for in the cited abstract;
//   5. write refcheck.json + REFCHECK.md (the `verification` template) and a
//      dossier whose source S<n> IS reference n, so a REPORT.md written from it
//      goes through `check` like any other.

import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Manifest, RawSource, Source } from "../types.js";
import { VERSION } from "../types.js";
import { officeToText, runId, slugify } from "../engine.js";
import { extractPdf } from "../backends/pdf.js";
import { buildSource, writeDossierIndex, writeSourceExtract } from "../dossier.js";
import { ensureDir, writeArtifact } from "../no-write.js";
import { RUN_SLUG } from "../util.js";
import { templateFor } from "../templates.js";
import { type CitedReference, parseReferences, splitDocument } from "./parse.js";
import { analyseCiting, type CitingAnalysis, numeralIn } from "./citing.js";
import { type DoiCheck, type ResolvedRecord, resolveReferences } from "./resolve.js";
import { type FieldDiff, diffReference, FIELDS, vancouverAuthors } from "./diff.js";

export interface RefcheckOptions {
  /** The reference list: .txt/.md (numbered), .bib, .docx/.odt, .pdf — or a whole document with a References heading. */
  refs: string;
  /** The citing text; defaults to the body of `refs` when that file has text before its reference list. */
  citing?: string;
  /** Output directory (default: a fresh run dir under the temp root). */
  out?: string;
  /** Parse and analyse only — no PubMed, Crossref or doi.org. */
  offline?: boolean;
  /** Write into an `out` that already holds a report written against an earlier run. */
  force?: boolean;
}

export type NumeralStatus = "found" | "absent" | "no-abstract";

export interface RefcheckEntry {
  n: number;
  raw: string;
  cited: CitedReference;
  status: "ok" | "discrepancies" | "unresolved" | "not-checked";
  record?: Omit<ResolvedRecord, "abstract"> & { hasAbstract: boolean };
  sourceId?: string;
  fields: FieldDiff[];
  doi?: DoiCheck;
  /** How many times the citing text calls it. */
  calls: number;
  /** What each citing passage states, figure by figure, against the abstract. */
  /** `in`: the co-cited references whose abstract holds the figure, when it was found in another's. */
  claims: { claim: string; numerals: { value: string; status: NumeralStatus; in?: number[] }[] }[];
}

export interface RefcheckSummary {
  references: number;
  resolved: number;
  viaPubmed: number;
  viaCrossref: number;
  unresolved: number;
  withDiscrepancies: number;
  fieldMismatches: number;
  fieldsMissing: number;
  /** Fields right in substance, worded a little differently (`≈`). */
  fieldsMinor: number;
  doisCited: number;
  doisBroken: number;
  uncited: number;
  unknownCalls: number;
  outOfOrder: number;
  numeralsChecked: number;
  numeralsAbsent: number;
}

export interface RefcheckResult {
  version: string;
  refsFile: string;
  citingFile?: string;
  builtAt: string;
  offline: boolean;
  dir: string;
  summary: RefcheckSummary;
  references: RefcheckEntry[];
  citing?: Omit<CitingAnalysis, "calls"> & { calls: number };
  notes: string[];
}

const TEXT_EXT = /\.(txt|md|markdown|bib|bibtex|text|ris)$/i;

/** Read any supported file as text: office documents with the engine's built-in reader, PDFs through the PDF ladder. */
export async function readDocumentText(path: string): Promise<string> {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`file not found: ${abs}`);
  const bytes = readFileSync(abs);
  const ext = extname(abs).toLowerCase();
  if (TEXT_EXT.test(ext) || !ext) return bytes.toString("utf8");
  if (ext === ".pdf") {
    const got = await extractPdf(bytes, {});
    if (!got.text) throw new Error(`could not extract text from ${basename(abs)}${got.reason ? ` — ${got.reason}` : ""}`);
    return got.text;
  }
  const text = officeToText(bytes);
  if (!text) throw new Error(`could not read ${basename(abs)} as an office document (.docx, .odt, .pptx, .xlsx)`);
  return text;
}

function recordText(ref: CitedReference, rec: ResolvedRecord): string {
  const where = [rec.journal, [rec.year, rec.volume ? `;${rec.volume}` : "", rec.issue ? `(${rec.issue})` : "", rec.pages ? `:${rec.pages}` : ""].join("")]
    .filter(Boolean)
    .join(". ");
  return [
    `# ${rec.title}`,
    "",
    `${vancouverAuthors(rec.authors)}. ${where}.`,
    [rec.pmid ? `PMID: ${rec.pmid}` : "", rec.pmcid ? `PMCID: ${rec.pmcid}` : "", rec.doi ? `DOI: ${rec.doi}` : ""].filter(Boolean).join(" · "),
    `Cited as reference [${ref.n}] — resolved via ${rec.via === "pubmed" ? "PubMed" : "Crossref"} (${rec.how}).`,
    "",
    "## Abstract",
    "",
    rec.abstract || "(no abstract on record)",
  ].join("\n");
}

function summarise(entries: RefcheckEntry[], citing: CitingAnalysis | undefined): RefcheckSummary {
  const fields = entries.flatMap((e) => e.fields);
  const numerals = entries.flatMap((e) => e.claims.flatMap((c) => c.numerals));
  return {
    references: entries.length,
    resolved: entries.filter((e) => e.record).length,
    viaPubmed: entries.filter((e) => e.record?.via === "pubmed").length,
    viaCrossref: entries.filter((e) => e.record?.via === "crossref").length,
    unresolved: entries.filter((e) => e.status === "unresolved").length,
    withDiscrepancies: entries.filter((e) => e.status === "discrepancies").length,
    fieldMismatches: fields.filter((f) => f.status === "mismatch").length,
    fieldsMissing: fields.filter((f) => f.status === "missing").length,
    fieldsMinor: fields.filter((f) => f.status === "minor").length,
    doisCited: entries.filter((e) => e.cited.doi).length,
    doisBroken: entries.filter((e) => e.doi?.resolves === false).length,
    uncited: citing?.uncited.length ?? 0,
    unknownCalls: citing?.unknown.length ?? 0,
    outOfOrder: citing?.outOfOrder.length ?? 0,
    numeralsChecked: numerals.filter((x) => x.status !== "no-abstract").length,
    numeralsAbsent: numerals.filter((x) => x.status === "absent").length,
  };
}

/** Run the whole check and write its outputs. */
export async function runRefcheck(opts: RefcheckOptions): Promise<RefcheckResult> {
  const refsText = await readDocumentText(opts.refs);
  const refs = parseReferences(refsText);
  if (!refs.length)
    throw new Error(`no reference found in ${basename(opts.refs)} — expected a numbered list ("1. Author A. Title. Journal. 2020;…") or a .bib file`);
  const notes: string[] = [];

  // The citing text: given, or the body of the reference file itself.
  let citingText: string | undefined;
  let citingFile: string | undefined;
  if (opts.citing) {
    citingFile = resolve(opts.citing);
    const raw = await readDocumentText(opts.citing);
    citingText = splitDocument(raw).body || raw;
  } else {
    const body = splitDocument(refsText).body;
    if (/\p{L}{3,}/u.test(body)) {
      citingText = body;
      citingFile = resolve(opts.refs);
      notes.push(`Citing text: the body of ${basename(opts.refs)}, before its reference list.`);
    }
  }
  const numbers = refs.map((r) => r.n);
  const citing = citingText ? analyseCiting(citingText, numbers) : undefined;
  if (citing && citing.style === "none") notes.push("No citation call ([n], (n) or superscript) was found in the citing text.");

  const resolved = opts.offline ? undefined : await resolveReferences(refs);
  if (resolved) notes.push(...resolved.notes);
  else notes.push("Offline: nothing was resolved — metadata, DOIs and figures are unchecked.");

  const builtAt = new Date().toISOString();
  const dir = resolve(opts.out ?? join(tmpdir(), "ultrasearch", `refcheck-${slugify(basename(opts.refs), RUN_SLUG)}`, runId()));
  if (existsSync(join(dir, "sources.json")) && !existsSync(join(dir, "refcheck.json"))) {
    throw new Error(`${dir} already holds a dossier that refcheck did not write — pass another --out`);
  }
  // A report written against an earlier run would be `check`ed against this
  // run's sources as if it were about them. Refused unless asked for; kept,
  // and flagged, when it is.
  const stale = ["REPORT.md", "SUMMARY.md", "index.html", "index.md"].filter((f) => existsSync(join(dir, f)));
  if (stale.length && !opts.force) {
    throw new Error(
      `${dir} already holds ${stale.join(", ")} from an earlier run — pass another --out, or --force to rewrite the check there (the report is kept, and must be re-read and re-checked against the new sources)`,
    );
  }
  if (stale.length) notes.push(`${stale.join(", ")} predate this run — re-read them against the new REFCHECK.md, then render and check again.`);

  const entries: RefcheckEntry[] = refs.map((ref) => {
    const rec = resolved?.records.get(ref.n);
    const fields = rec ? diffReference(ref, rec) : [];
    const doi = ref.doi ? resolved?.doiChecks.get(ref.doi.toLowerCase()) : undefined;
    if (doi?.resolves === false) {
      const d = fields.find((f) => f.field === "doi");
      if (d && d.status === "match") Object.assign(d, { status: "mismatch", note: "does not resolve on doi.org" });
      else if (!d) fields.push({ field: "doi", status: "mismatch", cited: ref.doi, note: "does not resolve on doi.org" });
    }
    const own = citing?.calls.filter((c) => c.numbers.includes(ref.n)) ?? [];
    // A call citing several references ("[26,27]") vouches for its figures
    // jointly: one found in ANY co-cited abstract is found for the sentence.
    const abstractOf = (n: number) => resolved?.records.get(n)?.abstract;
    const claims = own
      .filter((c) => c.numerals.length)
      .map((c) => ({
        claim: c.claim,
        numerals: c.numerals.map((value) => {
          if (rec?.abstract && numeralIn(value, rec.abstract)) return { value, status: "found" as NumeralStatus };
          const others = c.numbers.filter((n) => n !== ref.n && abstractOf(n) && numeralIn(value, abstractOf(n)!));
          if (others.length) return { value, status: "found" as NumeralStatus, in: others };
          return { value, status: (!rec?.abstract ? "no-abstract" : "absent") as NumeralStatus };
        }),
      }));
    const bad = fields.some((f) => f.status === "mismatch" || f.status === "missing");
    const status: RefcheckEntry["status"] = !resolved ? "not-checked" : !rec ? "unresolved" : bad || doi?.resolves === false ? "discrepancies" : "ok";
    const { abstract, ...meta } = rec ?? ({} as ResolvedRecord);
    return {
      n: ref.n,
      raw: ref.raw,
      cited: ref,
      status,
      ...(rec ? { record: { ...meta, hasAbstract: !!abstract } } : {}),
      fields,
      ...(doi ? { doi } : {}),
      calls: own.length,
      claims,
    };
  });

  // The dossier: one source per resolved reference, S<n> for reference n.
  ensureDir(dir);
  if (resolved) {
    ensureDir(join(dir, "sources"));
    const manifest: Manifest = {
      version: VERSION,
      question: `Reference check — ${basename(opts.refs)}`,
      mode: "research",
      template: "verification",
      depth: "deep",
      lang: "en",
      backends: ["pubmed", "crossref"],
      backendsUsed: [...new Set(entries.map((e) => e.record?.via).filter((v): v is "pubmed" | "crossref" => !!v))],
      sourceCount: 0,
      builtAt,
      slug: `refcheck-${slugify(basename(opts.refs), RUN_SLUG)}`,
      tiers: ["SUMMARY.md", "REPORT.md"],
      extras: ["bibtex"],
      notes: [
        "Built by `refcheck`: source S<n> is reference n (unresolved references have no source, so their ids are gaps).",
        "REFCHECK.md is the generated check; write REPORT.md to the verification template, citing [S#], then `check`.",
        ...notes,
      ],
      timings: {},
      cache: { enabled: false, hits: 0 },
    };
    const sources: Source[] = [];
    for (const e of entries) {
      const rec = resolved.records.get(e.n);
      if (!rec) continue;
      const raw: RawSource = {
        url: rec.url,
        title: rec.title || e.cited.title || `Reference ${e.n}`,
        backend: rec.via,
        score: 1,
        snippet: (rec.abstract ?? rec.title).replace(/\s+/g, " ").slice(0, 360),
        text: recordText(e.cited, rec),
        meta: {
          ...(rec.doi ? { doi: rec.doi } : {}),
          ...(rec.pmid ? { pmid: rec.pmid } : {}),
          ...(rec.pmcid ? { pmcid: rec.pmcid } : {}),
          authors: rec.authors,
          ...(rec.year ? { year: Number(rec.year) } : {}),
          ...(rec.journal ? { venue: rec.journal } : {}),
          reference: e.n,
        },
      };
      const s = buildSource(raw, `S${e.n}`, builtAt, manifest.question);
      writeSourceExtract(dir, s, raw.text!, manifest.depth, manifest.question);
      sources.push(s);
      e.sourceId = s.id;
    }
    manifest.sourceCount = sources.length;
    if (sources.length) writeDossierIndex(dir, sources, manifest, templateFor(manifest));
    else notes.push("No reference resolved: no dossier was written.");
  }

  const result: RefcheckResult = {
    version: VERSION,
    refsFile: resolve(opts.refs),
    ...(citingFile ? { citingFile } : {}),
    builtAt,
    offline: !resolved,
    dir,
    summary: summarise(entries, citing),
    references: entries,
    ...(citing ? { citing: { ...citing, calls: citing.calls.length } } : {}),
    notes,
  };
  writeArtifact(join(dir, "refcheck.json"), JSON.stringify(result, null, 2));
  writeArtifact(join(dir, "REFCHECK.md"), renderRefcheckMarkdown(result));
  return result;
}

// --- REFCHECK.md --------------------------------------------------------------

const cell = (s: string | undefined) => (s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const MARK: Record<FieldDiff["status"], string> = { match: "✓", minor: "≈", mismatch: "✗", missing: "∅" };

function fieldMark(e: RefcheckEntry, field: (typeof FIELDS)[number]): string {
  const f = e.fields.find((x) => x.field === field);
  return f ? MARK[f.status] : "—";
}

/** The generated report, to the `verification` template. */
export function renderRefcheckMarkdown(r: RefcheckResult): string {
  const s = r.summary;
  const out: string[] = [`# Reference check — ${basename(r.refsFile)}`, ""];
  out.push(
    `_Generated by ultrasearch ${r.version} on ${r.builtAt}. ✓ match · ≈ minor (a word or two) · ✗ mismatch · ∅ missing from the citation · — not judged._`,
    "",
  );

  out.push("## Verdict", "");
  if (r.offline) {
    out.push(`- ${s.references} reference(s) parsed. **Offline run**: nothing was looked up — metadata, DOIs and figures are unchecked.`);
  } else {
    out.push(
      `- ${s.references} reference(s): ${s.resolved} resolved (${s.viaPubmed} PubMed, ${s.viaCrossref} Crossref only), ${s.unresolved} unresolved.`,
      `- ${s.withDiscrepancies} reference(s) with a discrepancy: ${s.fieldMismatches} field mismatch(es), ${s.fieldsMissing} field(s) missing from the citation${s.fieldsMinor ? `; ${s.fieldsMinor} minor wording difference(s)` : ""}.`,
      `- DOIs: ${s.doisCited} cited, ${s.doisBroken} not resolving on doi.org.`,
    );
  }
  if (r.citing) {
    out.push(
      `- Citing text (${r.citing.style} calls, ${r.citing.calls} call site(s)): ${s.uncited} reference(s) never cited, ${s.unknownCalls} call(s) to a number not in the list, ${s.outOfOrder} reference(s) out of Vancouver order.`,
    );
    if (!r.offline) out.push(`- Figures: ${s.numeralsChecked} checked against the cited abstract, ${s.numeralsAbsent} not found there.`);
  } else {
    out.push("- No citing text: orphans, order and figures were not checked (pass `--citing <file>`).");
  }
  out.push("");

  out.push("## Reference-by-reference table", "");
  out.push(`| # | Status | Resolved as | ${FIELDS.map((f) => f).join(" | ")} | Calls | Source |`);
  out.push(`|---|---|---|${FIELDS.map(() => "---").join("|")}|---|---|`);
  for (const e of r.references) {
    const as = e.record ? `${e.record.via === "pubmed" ? `PMID ${e.record.pmid}` : `DOI ${e.record.doi}`}` : "—";
    out.push(
      `| ${e.n} | ${e.status} | ${cell(as)} | ${FIELDS.map((f) => fieldMark(e, f)).join(" | ")} | ${e.calls} | ${e.sourceId ? `[${e.sourceId}]` : "—"} |`,
    );
  }
  out.push("");

  out.push("## Discrepancies", "");
  const bad = r.references.filter((e) => e.fields.some((f) => f.status !== "match") || e.fields.some((f) => f.note?.startsWith("style:")));
  if (!bad.length) out.push(r.offline ? "_Not checked (offline)._" : "_None: every resolved reference matches its record._");
  for (const e of bad) {
    out.push(`### [${e.n}] ${cell(e.cited.title ?? e.raw).slice(0, 140)}${e.sourceId ? ` [${e.sourceId}]` : ""}`, "");
    for (const f of e.fields) {
      if (f.status === "match" && !f.note?.startsWith("style:")) continue;
      const what =
        f.status === "missing"
          ? `missing — the record has \`${cell(f.expected)}\``
          : f.status === "mismatch" || f.status === "minor"
            ? `${f.status === "minor" ? "minor — " : ""}cited \`${cell(f.cited)}\`${f.expected ? ` — record has \`${cell(f.expected)}\`` : ""}`
            : "matches";
      out.push(`- **${f.field}**: ${what}${f.note ? ` (${f.note})` : ""}`);
    }
    out.push("");
  }

  out.push("## Claims checked against their sources", "");
  if (!r.citing) out.push("_No citing text._");
  else {
    if (r.citing.uncited.length) out.push(`- **Never cited:** ${r.citing.uncited.map((n) => `[${n}]`).join(", ")}`);
    if (r.citing.unknown.length) out.push(`- **Called but not in the list:** ${r.citing.unknown.map((n) => `[${n}]`).join(", ")}`);
    if (r.citing.outOfOrder.length) {
      out.push(`- **Out of Vancouver order** (first cited after a higher number): ${r.citing.outOfOrder.map((o) => `[${o.n}] after [${o.after}]`).join(", ")}`);
    }
    if (!r.citing.uncited.length && !r.citing.unknown.length && !r.citing.outOfOrder.length) {
      out.push("- Every reference is cited, every call has a reference, and first citations run in order.");
    }
    const rows = r.references.flatMap((e) =>
      e.claims.flatMap((c) =>
        c.numerals.map((nu) => ({
          e,
          claim: c.claim,
          value: nu.value,
          status: nu.in ? `${nu.status} (in ${nu.in.map((n) => `[${n}]`).join(", ")}, co-cited)` : nu.status,
        })),
      ),
    );
    if (rows.length) {
      out.push("", "| Ref | Figure | In the abstract | Citing passage |", "|---|---|---|---|");
      for (const x of rows) {
        out.push(`| [${x.e.n}]${x.e.sourceId ? ` [${x.e.sourceId}]` : ""} | ${x.value} | ${x.status} | ${cell(x.claim).slice(0, 220)} |`);
      }
      out.push(
        "",
        "_A figure absent from an abstract is a lead, not a verdict: it may come from the full text, a table, or a calculation. Open the article before calling it wrong._",
      );
    }
  }
  out.push("");

  out.push("## Not verifiable", "");
  const nv = r.references.filter((e) => e.status === "unresolved" || e.status === "not-checked" || (e.record && !e.record.hasAbstract));
  if (!nv.length) out.push("_Nothing: every reference resolved, with an abstract._");
  for (const e of nv) {
    const why =
      e.status === "not-checked"
        ? "offline run"
        : e.status === "unresolved"
          ? "not found on PubMed or Crossref — check the reference by hand"
          : "resolved, but the record has no abstract: its figures could not be checked";
    out.push(`- [${e.n}] ${cell(e.raw).slice(0, 160)} — ${why}`);
  }
  out.push("");

  out.push("## Open questions", "");
  out.push("- Which discrepancies are typos in the citation, and which point at the wrong article?");
  if (!r.offline && r.summary.numeralsAbsent) out.push("- Do the figures missing from the abstracts appear in the full texts?");
  if (r.summary.unresolved) out.push("- Do the unresolved references exist (books, chapters, theses and grey literature are rarely indexed)?");
  for (const n of r.notes) out.push(`- Note: ${n}`);
  out.push("");
  return out.join("\n");
}
