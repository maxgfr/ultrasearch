// Reading a bibliography: a numbered Vancouver list (plain text, Markdown, or
// the text of a .docx) or a BibTeX file, into one record per reference with the
// fields a reference check compares — authors, title, journal, year, volume,
// issue, pages, DOI, PMID.
//
// The parser is deliberately forgiving and deliberately honest: a reference it
// cannot split keeps its raw text and leaves the fields it could not find
// undefined, and the diff reports them as missing rather than inventing them.

export interface CitedReference {
  /** The number the document gives it ([n]); for BibTeX, the entry's position. */
  n: number;
  /** The reference exactly as written (number stripped), for the report. */
  raw: string;
  /** "Surname Initials", in the order written, without "et al.". */
  authors: string[];
  /** The list ends with "et al." (or BibTeX "and others"). */
  etAl: boolean;
  title?: string;
  journal?: string;
  year?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  /** BibTeX citation key, when the list came from a .bib. */
  key?: string;
}

const REF_HEADING =
  /^\s{0,3}(?:#{1,6}\s*)?(?:\d+[.)]?\s+)?(r[ée]f[ée]rences(?:\s+bibliographiques)?|bibliograph(?:y|ie)|references|works cited|literature cited|literatur(?:verzeichnis)?|referencias|bibliografia)\s*:?\s*$/i;
const HEADING = /^\s{0,3}#{1,6}\s+\S/;
// "1. ", "1) ", "[1] ", "1 " (a bare number then a capitalised word).
const NUMBERED = /^\s*(?:\[(\d{1,4})\]|(\d{1,4})[.)]|(\d{1,4})(?=\s+\p{Lu}))\s*(.*)$/u;

/** Index of the line that opens the reference list (its heading), or -1. The LAST such heading wins. */
export function referenceHeadingLine(lines: string[]): number {
  let at = -1;
  for (let i = 0; i < lines.length; i++) if (REF_HEADING.test(lines[i]!.trim())) at = i;
  return at;
}

/**
 * Split a document into its body (the citing text) and its reference list.
 * Without a references heading the whole text is taken as the list.
 */
export function splitDocument(text: string): { body: string; list: string; hadHeading: boolean } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const at = referenceHeadingLine(lines);
  if (at < 0) return { body: "", list: text, hadHeading: false };
  // The list runs to the next heading that is not itself a numbered reference
  // (an appendix after the bibliography), or to the end.
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    if (HEADING.test(lines[i]!) && !NUMBERED.test(lines[i]!.replace(/^\s*#+\s*/, ""))) {
      end = i;
      break;
    }
  }
  return { body: [...lines.slice(0, at), ...lines.slice(end)].join("\n"), list: lines.slice(at + 1, end).join("\n"), hadHeading: true };
}

/** Split a reference list into its entries, numbered as written (or 1..n when the numbering was lost). */
export function splitEntries(list: string): { n: number; raw: string }[] {
  const lines = list.replace(/\r\n?/g, "\n").split("\n");
  const numbered = lines.filter((l) => NUMBERED.test(l) && l.trim().length > 12).length;
  const out: { n: number; raw: string }[] = [];
  if (numbered >= 2) {
    for (const line of lines) {
      const t = line.trim();
      if (!t || HEADING.test(line)) continue;
      const m = NUMBERED.exec(t);
      if (m && (m[4] ?? "").length > 8) out.push({ n: Number(m[1] ?? m[2] ?? m[3]), raw: m[4]!.trim() });
      else if (out.length) out[out.length - 1]!.raw += ` ${t}`;
    }
    return out;
  }
  // No numbering survived (Word's automatic list numbering is not text): one
  // paragraph per reference, numbered in order.
  const paras = list
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n|\n(?=\s*\p{Lu}[\p{L}'’ -]+ \p{Lu}{1,4}[,.])/u)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 12 && !HEADING.test(p));
  return paras.map((raw, i) => ({ n: i + 1, raw: raw.replace(/^[-*•]\s+/, "") }));
}

const DOI_RE = /(?:\bdoi:?\s*|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d{4,9}\/[^\s"<>]+)|\b(10\.\d{4,9}\/[^\s"<>]+)/i;
// ". 2022;36(2):157-162" · ". 2015;15:143" · ". 2024 Mar;12(3):e45" · ". 2021;100(32):e26728"
const DATE_VOL =
  /[.?!]\s*((?:19|20)\d{2})(?:\s+[A-Z][a-z]{2}(?:[-–\s]+[A-Z]?[a-z]{0,2})?(?:\s+\d{1,2})?)?\s*;\s*([^():;.\s][^():;.]*?)?\s*(?:\(([^)]*)\))?\s*(?::\s*([A-Za-z]?\d+[A-Za-z]?(?:\s*[-–]\s*[A-Za-z]?\d+[A-Za-z]?)?))?\s*(?:\.|$)/;
// A date with no volume (online first): ". 2024 Mar 5." / ". 2024."
const DATE_ONLY = /[.?!]\s*((?:19|20)\d{2})(?:\s+[A-Z][a-z]{2}(?:\s+\d{1,2})?)?\s*\.(?:\s|$)/;
// "Gurney NT" · "Al-Mohtaseb Z" · "van den Biggelaar FJHM" · "de Oliveira Rassi TN" · "et al"
const AUTHOR_TOKEN = /^(?:(?:\p{Ll}{1,4}\s+)*\p{Lu}[\p{L}'’-]*(?:\s+(?:\p{Ll}{1,4}\s+)*\p{L}[\p{L}'’-]*)*\s+\p{Lu}{1,4}(?:\s+(?:Jr|Sr|II|III|IV))?|et\s+al)$/u;

function trimDoi(doi: string): string {
  return doi.replace(/[.,;:)\]]+$/, "");
}

/** Split "Surname AB, Other C, et al" into names + et-al flag, or undefined when it does not read as an author list. */
export function parseAuthorList(s: string): { authors: string[]; etAl: boolean } | undefined {
  const tokens = s
    .split(/\s*,\s*/)
    .map((t) => t.trim().replace(/\.$/, ""))
    .filter(Boolean);
  if (!tokens.length || !tokens.every((t) => AUTHOR_TOKEN.test(t))) return undefined;
  const etAl = tokens.some((t) => /^et\s+al$/i.test(t));
  return { authors: tokens.filter((t) => !/^et\s+al$/i.test(t)), etAl };
}

/** Parse one Vancouver-style reference string into its fields. */
export function parseVancouver(raw: string, n: number): CitedReference {
  const ref: CitedReference = { n, raw, authors: [], etAl: false };
  let work = ` ${raw.replace(/\s+/g, " ").trim()}`;

  const doi = DOI_RE.exec(work);
  if (doi) {
    ref.doi = trimDoi(doi[1] ?? doi[2]!);
    work = work.slice(0, doi.index) + work.slice(doi.index + doi[0].length);
  }
  const pmid = /\bPMID:?\s*(\d{4,9})/i.exec(work);
  if (pmid) {
    ref.pmid = pmid[1];
    work = work.replace(pmid[0], " ");
  }
  const pmcid = /\bPMCID:?\s*(PMC\d+)|\b(PMC\d{4,})\b/i.exec(work);
  if (pmcid) {
    ref.pmcid = (pmcid[1] ?? pmcid[2])!.toUpperCase();
    work = work.replace(pmcid[0], " ");
  }
  work = work.replace(/\s+(?:Epub|Published)\b[^.]*\.?/gi, " ").replace(/\s+/g, " ");

  // The first sentence break whose prefix reads as an author list ends the authors.
  let rest = work.trim();
  for (const m of rest.matchAll(/\.\s+/g)) {
    const parsed = parseAuthorList(rest.slice(0, m.index));
    if (parsed) {
      ref.authors = parsed.authors;
      ref.etAl = parsed.etAl;
      rest = rest.slice(m.index! + m[0].length);
    }
    break;
  }

  const dv = DATE_VOL.exec(rest) ?? DATE_ONLY.exec(rest);
  let head = rest;
  if (dv) {
    head = rest.slice(0, dv.index + 1);
    ref.year = dv[1];
    if (dv[2]?.trim()) ref.volume = dv[2].trim();
    if (dv[3]?.trim()) ref.issue = dv[3].trim();
    if (dv[4]?.trim()) ref.pages = dv[4].replace(/\s+/g, "").replace(/–/g, "-");
  }
  // "Title. Journal." — the journal is the last sentence before the date. NLM
  // abbreviations carry no periods, so the last break is the right one.
  head = head.trim().replace(/[.]$/, "");
  const breaks = [...head.matchAll(/[.?!]\s+/g)];
  const last = breaks.at(-1);
  if (dv && last) {
    ref.title = head.slice(0, last.index! + (last[0].startsWith(".") ? 0 : 1)).trim();
    ref.journal = head.slice(last.index! + last[0].length).trim() || undefined;
  } else if (head) {
    ref.title = head;
  }
  if (ref.title === "") delete ref.title;
  return ref;
}

// --- BibTeX ---------------------------------------------------------------

function bibValue(s: string, i: number): { value: string; end: number } {
  while (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r") i++;
  if (s[i] === "{") {
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}" && --depth === 0) break;
    }
    return { value: s.slice(i + 1, j), end: j + 1 };
  }
  if (s[i] === '"') {
    let j = i + 1;
    let depth = 0;
    for (; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}") depth--;
      else if (s[j] === '"' && depth === 0) break;
    }
    return { value: s.slice(i + 1, j), end: j + 1 };
  }
  const m = /^[^,}\s]+/.exec(s.slice(i));
  return { value: m ? m[0] : "", end: i + (m ? m[0].length : 0) };
}

const unbrace = (s: string) => s.replace(/\\&/g, "&").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();

// "Gurney, Nicholas T." / "Nicholas T. Gurney" → "Gurney NT".
export function vancouverName(name: string): string {
  const n = unbrace(name);
  let family: string;
  let given: string;
  if (n.includes(",")) [family, given] = [n.slice(0, n.indexOf(",")).trim(), n.slice(n.indexOf(",") + 1).trim()];
  else {
    const parts = n.split(/\s+/);
    family = parts.pop() ?? n;
    given = parts.join(" ");
  }
  const initials = given
    .split(/[\s.-]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .join("");
  return initials ? `${family} ${initials}` : family;
}

/** Parse every @article/@inproceedings/… entry of a BibTeX file, numbered in file order. */
export function parseBibtex(text: string): CitedReference[] {
  const out: CitedReference[] = [];
  const re = /@(\w+)\s*\{\s*([^,\s]*)\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (/^(comment|preamble|string)$/i.test(m[1]!)) continue;
    const fields: Record<string, string> = {};
    let i = re.lastIndex;
    for (;;) {
      const f = /^\s*([A-Za-z][\w-]*)\s*=\s*/.exec(text.slice(i));
      if (!f) break;
      const v = bibValue(text, i + f[0].length);
      fields[f[1]!.toLowerCase()] = v.value;
      i = v.end;
      const sep = /^\s*,?/.exec(text.slice(i));
      i += sep ? sep[0].length : 0;
      if (text[i] === "}") break;
    }
    re.lastIndex = i;
    const names = fields.author ? unbrace(fields.author).split(/\s+and\s+/i) : [];
    const etAl = names.some((x) => /^others$/i.test(x.trim()));
    const authors = names.filter((x) => !/^others$/i.test(x.trim())).map(vancouverName);
    const n = out.length + 1;
    const ref: CitedReference = {
      n,
      key: m[2] || undefined,
      raw: [authors.join(", ") + (etAl ? ", et al" : ""), unbrace(fields.title ?? ""), unbrace(fields.journal ?? fields.booktitle ?? ""), fields.year]
        .filter(Boolean)
        .join(". "),
      authors,
      etAl,
    };
    if (fields.title) ref.title = unbrace(fields.title);
    if (fields.journal || fields.booktitle) ref.journal = unbrace(fields.journal ?? fields.booktitle!);
    if (fields.year) ref.year = unbrace(fields.year);
    if (fields.volume) ref.volume = unbrace(fields.volume);
    if (fields.number || fields.issue) ref.issue = unbrace(fields.number ?? fields.issue!);
    if (fields.pages) ref.pages = unbrace(fields.pages).replace(/-{2,}|–/g, "-");
    if (fields.doi) ref.doi = trimDoi(unbrace(fields.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""));
    if (fields.pmid) ref.pmid = unbrace(fields.pmid);
    out.push(ref);
  }
  return out;
}

/** Parse a reference list in whatever form it came: BibTeX when it looks like one, else a numbered Vancouver list. */
export function parseReferences(text: string): CitedReference[] {
  if (/@\w+\s*\{[^,\s]*\s*,/.test(text) && /\b(title|author)\s*=/.test(text)) return parseBibtex(text);
  return splitEntries(splitDocument(text).list).map((e) => parseVancouver(e.raw, e.n));
}
