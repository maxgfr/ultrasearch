// Field-by-field comparison of a reference as cited against the record it
// resolved to. Each field is `match`, `mismatch` (with the expected value) or
// `missing` (the citation omits something the record has). A field the record
// itself lacks is not judged.

import { deaccent } from "../engine.js";
import type { CitedReference } from "./parse.js";
import type { ResolvedRecord } from "./resolve.js";

export type FieldName = "authors" | "title" | "journal" | "year" | "volume" | "issue" | "pages" | "doi";
export const FIELDS: readonly FieldName[] = ["authors", "title", "journal", "year", "volume", "issue", "pages", "doi"];

export interface FieldDiff {
  field: FieldName;
  status: "match" | "mismatch" | "missing";
  cited?: string;
  expected?: string;
  note?: string;
}

/** How many authors Vancouver lists before "et al." (ICMJE / NLM). */
export const VANCOUVER_AUTHORS = 6;

const norm = (s: string) =>
  deaccent(s.toLowerCase())
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Token-overlap similarity of two titles, 0..1 (accents, case and punctuation ignored). */
export function titleSimilarity(a: string, b: string): number {
  const ta = norm(a).split(" ").filter(Boolean);
  const tb = norm(b).split(" ").filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  const sb = new Set(tb);
  const common = ta.filter((t) => sb.has(t)).length;
  return common / Math.max(ta.length, tb.length);
}

/** "157-62" → "157-162"; "e26728" stays; "157" stays. */
export function expandPages(p: string): string {
  const m = /^([A-Za-z]?)(\d+)([A-Za-z]?)\s*[-–]\s*([A-Za-z]?)(\d+)([A-Za-z]?)$/.exec(p.trim());
  if (!m) return p.trim();
  const [, pre, a, , , b] = m;
  const last = b!.length < a!.length ? a!.slice(0, a!.length - b!.length) + b : b;
  return `${pre}${a}-${pre}${last}`;
}

/** The author list as Vancouver writes it from the record: the first six, then "et al.". */
export function vancouverAuthors(authors: string[]): string {
  return authors.length > VANCOUVER_AUTHORS ? `${authors.slice(0, VANCOUVER_AUTHORS).join(", ")}, et al.` : authors.join(", ");
}

function splitName(a: string): { family: string; initials: string } {
  const m = /^(.*\S)\s+(\p{Lu}{1,4})$/u.exec(a.trim());
  return m ? { family: norm(m[1]!), initials: m[2]! } : { family: norm(a), initials: "" };
}

function diffAuthors(ref: CitedReference, rec: ResolvedRecord): FieldDiff {
  const expected = vancouverAuthors(rec.authors);
  if (!rec.authors.length) return { field: "authors", status: "match", note: "the record lists no individual author" };
  const cited = ref.authors.join(", ") + (ref.etAl ? ", et al." : "");
  if (!ref.authors.length) return { field: "authors", status: "missing", expected };
  const problems: string[] = [];
  ref.authors.forEach((a, i) => {
    const want = rec.authors[i];
    if (!want) {
      problems.push(`"${a}" is not an author on the record (${rec.authors.length} listed)`);
      return;
    }
    const x = splitName(a);
    const y = splitName(want);
    if (x.family !== y.family) problems.push(`author ${i + 1}: "${a}" — record has "${want}"`);
    else if (x.initials && y.initials && x.initials !== y.initials) problems.push(`author ${i + 1}: initials "${x.initials}" — record has "${y.initials}"`);
  });
  if (!ref.etAl && ref.authors.length < rec.authors.length) {
    problems.push(`${ref.authors.length} of ${rec.authors.length} authors listed and no "et al."`);
  }
  if (problems.length) return { field: "authors", status: "mismatch", cited, expected, note: problems.join("; ") };
  // Right names, a shorter list: a house style, not an error — say so once.
  const style =
    ref.etAl && rec.authors.length > VANCOUVER_AUTHORS && ref.authors.length < VANCOUVER_AUTHORS
      ? `style: ${ref.authors.length} author(s) before "et al." (Vancouver lists ${VANCOUVER_AUTHORS})`
      : ref.etAl && rec.authors.length <= VANCOUVER_AUTHORS
        ? `style: "et al." although the record has only ${rec.authors.length} author(s) (Vancouver lists them all)`
        : undefined;
  return { field: "authors", status: "match", cited, expected, ...(style ? { note: style } : {}) };
}

function simple(field: FieldName, cited: string | undefined, expected: string | undefined, same: (a: string, b: string) => boolean): FieldDiff | undefined {
  if (!expected) return undefined; // the record cannot judge it
  if (!cited) return { field, status: "missing", expected };
  return same(cited, expected) ? { field, status: "match", cited, expected } : { field, status: "mismatch", cited, expected };
}

/** Compare one cited reference with the record it resolved to, field by field. */
export function diffReference(ref: CitedReference, rec: ResolvedRecord): FieldDiff[] {
  const out: FieldDiff[] = [diffAuthors(ref, rec)];
  const title = simple("title", ref.title?.replace(/[.]$/, ""), rec.title.replace(/[.]$/, ""), (a, b) => norm(a) === norm(b));
  if (title?.status === "mismatch") title.note = `${Math.round(titleSimilarity(title.cited!, title.expected!) * 100)}% of words in common`;
  const journal = simple("journal", ref.journal, rec.journal, (a, b) => norm(a) === norm(b) || (!!rec.journalFull && norm(a) === norm(rec.journalFull)));
  if (journal && rec.via === "crossref") journal.note = "Crossref short title — not necessarily the NLM abbreviation";
  else if (journal?.status === "mismatch") journal.note = "the NLM abbreviation is the PubMed one";
  const rest = [
    title,
    journal,
    simple("year", ref.year, rec.year, (a, b) => a.trim() === b.trim()),
    simple("volume", ref.volume, rec.volume, (a, b) => norm(a) === norm(b)),
    simple("issue", ref.issue, rec.issue, (a, b) => norm(a) === norm(b)),
    simple("pages", ref.pages, rec.pages, (a, b) => expandPages(a).toLowerCase() === expandPages(b).toLowerCase()),
    simple("doi", ref.doi, rec.doi, (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase()),
  ];
  for (const d of rest) if (d) out.push(d);
  return out;
}
