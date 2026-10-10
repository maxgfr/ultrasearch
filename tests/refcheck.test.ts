import "./_fastfetch.js"; // FIRST: no polite delay between the mocked E-utilities calls
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseAuthorList, parseBibtex, parseReferences, parseVancouver, splitDocument, splitEntries, vancouverName } from "../src/refcheck/parse.js";
import { analyseCiting, detectStyle, expandCallList, numeralIn } from "../src/refcheck/citing.js";
import { diffReference, expandPages, titleSimilarity, vancouverAuthors } from "../src/refcheck/diff.js";
import { checkDoi, crossrefBibliographic, resolveReferences } from "../src/refcheck/resolve.js";
import { readDocumentText, renderRefcheckMarkdown, runRefcheck } from "../src/refcheck/index.js";
import { runCheck } from "../src/check.js";
import { main } from "../src/cli.js";
import { callTool } from "../src/mcp/handlers.js";
import type { Source } from "../src/types.js";
import { installFetchMock, type MockResponse } from "./fetchmock.js";
import { makeDocx } from "./docxfix.js";

afterEach(() => vi.unstubAllGlobals());

const REFS = [
  "1. Gurney NT, Al-Mohtaseb Z. Intraocular lens implantation in the absence of capsular support. Saudi J Ophthalmol. 2022;36(2):157-62. doi:10.4103/sjopt.sjopt_186_21.",
  "2. Segers MHM, Behndig A, van den Biggelaar FJHM, et al. Risk factors for posterior capsule rupture. J Cataract Refract Surg. 2021;48(1):51-55. doi:10.1097/j.jcrs.0000000000000708.",
  "3. Doe J. A paper only Crossref knows. Some Journal. 2019;5:10-20. doi:10.9999/fake.",
  "4. Nobody X. An unfindable work. Nowhere J. 2018;1:1.",
];
const BODY = [
  "# Introduction",
  "Posterior capsule rupture concerned 1 % of more than 2,8 millions procedures [2]. Without capsular support another technique is needed [1,2].",
  "A protocol nobody listed is cited here [5]. The Crossref-only paper followed 120 eyes [3].",
];

const ESUMMARY = {
  result: {
    "36211319": {
      title: "Intraocular lens implantation in the absence of capsular support.",
      source: "Saudi J Ophthalmol",
      fulljournalname: "Saudi journal of ophthalmology",
      pubdate: "2022 Apr-Jun",
      volume: "36",
      issue: "2",
      pages: "157-162",
      authors: [
        { name: "Gurney NT", authtype: "Author" },
        { name: "Al-Mohtaseb Z", authtype: "Author" },
      ],
      articleids: [
        { idtype: "doi", value: "10.4103/sjopt.sjopt_186_21" },
        { idtype: "pmc", value: "PMC9535910" },
      ],
    },
    "34074994": {
      title: "Risk factors for posterior capsule rupture.",
      source: "J Cataract Refract Surg",
      pubdate: "2022 Jan 1",
      volume: "48",
      issue: "1",
      pages: "51-55",
      authors: ["Segers MHM", "Behndig A", "van den Biggelaar FJHM", "Brocato L", "Henry YP", "Nuijts RMMA", "Lundström M"].map((name) => ({
        name,
        authtype: "Author",
      })),
      articleids: [{ idtype: "doi", value: "10.1097/j.jcrs.0000000000000708" }],
    },
  },
};
const EFETCH = `<?xml version="1.0"?><PubmedArticleSet>
<PubmedArticle><MedlineCitation><PMID Version="1">34074994</PMID><Article><Abstract>
<AbstractText Label="PURPOSE">To identify risk factors.</AbstractText>
<AbstractText Label="RESULTS">Of 2.8 million procedures, 1.1% had a rupture &amp; <i>more</i>.</AbstractText>
</Abstract></Article></MedlineCitation></PubmedArticle>
<PubmedArticle><MedlineCitation><PMID Version="1">36211319</PMID><Article><Abstract><AbstractText>No figures here.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>
</PubmedArticleSet>`;
const CROSSREF_FAKE = {
  message: {
    DOI: "10.9999/fake",
    title: ["A paper only Crossref knows"],
    "container-title": ["Some Journal of Things"],
    "short-container-title": ["Some Journal"],
    author: [{ given: "John", family: "Doe" }],
    issued: { "date-parts": [[2019]] },
    volume: "5",
    page: "10-20",
    abstract: "<jats:p>We followed 120 eyes.</jats:p>",
  },
};

const json = (o: unknown): MockResponse => ({ body: JSON.stringify(o), contentType: "application/json" });

function network(calls: string[] = []) {
  return installFetchMock((url) => {
    calls.push(url);
    if (url.includes("ecitmatch.cgi"))
      return {
        body: "Saudi J Ophthalmol|2022|36|157|Gurney NT|1|36211319\nJ Cataract Refract Surg|2021|48|51|Segers MHM|2|NOT_FOUND\n",
        contentType: "text/plain",
      };
    if (url.includes("esearch.fcgi")) {
      const term = decodeURIComponent(url.split("term=")[1] ?? "");
      if (term.startsWith("10.1097/j.jcrs.0000000000000708[aid]")) return json({ esearchresult: { idlist: ["34074994"] } });
      return json({ esearchresult: { idlist: [] } });
    }
    if (url.includes("esummary.fcgi")) return json(ESUMMARY);
    if (url.includes("efetch.fcgi")) return { body: EFETCH, contentType: "application/xml" };
    if (url.includes("api.crossref.org/works/10.9999")) return json(CROSSREF_FAKE);
    if (url.includes("api.crossref.org/works?")) return json({ message: { items: [{ DOI: "10.1/other", title: ["Something else entirely"] }] } });
    if (url.includes("api.crossref.org/works/")) return { status: 404, body: "" };
    if (url.includes("doi.org/api/handles/10.9999")) return json({ responseCode: 100 });
    if (url.includes("doi.org/api/handles/")) return json({ responseCode: 1, values: [{ type: "URL", data: { value: "https://publisher.test/x" } }] });
    return undefined;
  });
}

describe("refcheck — parsing a bibliography", () => {
  it("splits a Vancouver reference into its fields", () => {
    const r = parseVancouver(REFS[1]!.slice(3), 2);
    expect(r.authors).toEqual(["Segers MHM", "Behndig A", "van den Biggelaar FJHM"]);
    expect(r.etAl).toBe(true);
    expect(r).toMatchObject({
      title: "Risk factors for posterior capsule rupture",
      journal: "J Cataract Refract Surg",
      year: "2021",
      volume: "48",
      issue: "1",
      pages: "51-55",
    });
    expect(r.doi).toBe("10.1097/j.jcrs.0000000000000708");
    const med = parseVancouver("Fiore T, Messina M. Comparison of two techniques. Medicine (Baltimore). 2021;100(32):e26728. PMID: 34397876", 19);
    expect(med).toMatchObject({ journal: "Medicine (Baltimore)", pages: "e26728", pmid: "34397876" });
    const bmc = parseVancouver("Forlini M, Soliman W. Long-term follow-up: a retrospective analysis. BMC Ophthalmol. 2015;15:143.", 9);
    expect(bmc).toMatchObject({ volume: "15", pages: "143" });
    expect(bmc.issue).toBeUndefined();
    const q = parseVancouver("Roe A. Does it work? Lancet. 2020 Mar;395(10227):1-2. https://doi.org/10.1016/X.", 1);
    expect(q).toMatchObject({ title: "Does it work?", journal: "Lancet", year: "2020", doi: "10.1016/X" });
    const online = parseVancouver("Roe A. Ahead of print. Eye. 2025 Jan 4. PMCID: PMC123456", 1);
    expect(online).toMatchObject({ year: "2025", pmcid: "PMC123456" });
    const group = parseVancouver("American Academy of Ophthalmology. Preferred practice pattern. Ophthalmology. 2020;1:1.", 1);
    expect(group.authors).toEqual([]);
  });

  it("reads author lists, particles and initials", () => {
    expect(parseAuthorList("de Oliveira Rassi TN, Al-Mohtaseb Z, et al")).toEqual({ authors: ["de Oliveira Rassi TN", "Al-Mohtaseb Z"], etAl: true });
    expect(parseAuthorList("Intraocular lens implantation")).toBeUndefined();
    expect(vancouverName("Gurney, Nicholas T.")).toBe("Gurney NT");
    expect(vancouverName("Zaina Al-Mohtaseb")).toBe("Al-Mohtaseb Z");
    expect(vancouverName("Plato")).toBe("Plato");
  });

  it("finds the list under its heading, keeps the body as the citing text, and renumbers an unnumbered list", () => {
    const doc = [...BODY, "", "# Références", "", ...REFS, "", "# Annexes", "Annex text."].join("\n");
    const split = splitDocument(doc);
    expect(split.hadHeading).toBe(true);
    expect(split.body).toContain("2,8 millions");
    expect(split.body).toContain("Annex text.");
    expect(splitEntries(split.list).map((e) => e.n)).toEqual([1, 2, 3, 4]);
    expect(splitDocument("no heading at all").hadHeading).toBe(false);
    // Word's automatic numbering is not text: one paragraph per reference.
    const loose = splitEntries("Gurney NT. First title. J A. 2020;1:1.\n\nDoe J. Second title. J B. 2021;2:2.");
    expect(loose.map((e) => e.n)).toEqual([1, 2]);
    // A wrapped reference continues on the next line.
    const wrapped = splitEntries("[1] Gurney NT. A long title that\nwraps. J A. 2020;1:1.\n[2] Doe J. Second title. J B. 2021;2:2.");
    expect(wrapped[0]!.raw).toContain("that wraps.");
    expect(parseReferences(doc)).toHaveLength(4);
  });

  it("parses BibTeX, braces, 'and others' and page ranges", () => {
    const bib = `@comment{x}
@article{gurney2022,
  author = {Gurney, Nicholas T. and {Al-Mohtaseb}, Zaina and others},
  title = {Intraocular lens implantation in the {absence} of capsular support},
  journal = "Saudi J Ophthalmol",
  year = 2022, volume = {36}, number = {2}, pages = {157--162},
  doi = {https://doi.org/10.4103/sjopt.sjopt_186_21}, pmid = {36211319}
}
@inproceedings{x, title = {A talk}, booktitle = {Conf}, issue = {3}}`;
    const refs = parseBibtex(bib);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({
      n: 1,
      key: "gurney2022",
      authors: ["Gurney NT", "Al-Mohtaseb Z"],
      etAl: true,
      pages: "157-162",
      doi: "10.4103/sjopt.sjopt_186_21",
      pmid: "36211319",
      issue: "2",
    });
    expect(refs[0]!.title).toBe("Intraocular lens implantation in the absence of capsular support");
    expect(refs[1]).toMatchObject({ journal: "Conf", issue: "3" });
    expect(parseReferences(bib)).toHaveLength(2);
  });
});

describe("refcheck — reading the citing text", () => {
  it("expands call lists and rejects intervals", () => {
    expect(expandCallList("4,5")).toEqual([4, 5]);
    expect(expandCallList("2, 7–9")).toEqual([2, 7, 8, 9]);
    expect(expandCallList("18 – 88")).toEqual([]); // "71 [18 – 88]" is a range of ages
    expect(expandCallList("9-3")).toEqual([]);
  });

  it("finds orphans, unknown calls, Vancouver order, and attaches figures to the right call", () => {
    const a = analyseCiting(BODY.join("\n"), [1, 2, 3, 4]);
    expect(a.style).toBe("brackets");
    expect(a.uncited).toEqual([4]);
    expect(a.unknown).toEqual([5]);
    expect(a.firstCitationOrder).toEqual([2, 1, 5, 3]);
    expect(a.outOfOrder).toEqual([
      { n: 1, after: 2 },
      { n: 3, after: 5 },
    ]);
    const first = a.calls[0]!;
    expect(first.numerals).toEqual(["2.8"]);
    // "séries de 78 [21], 72 [22]": each figure goes to its own call.
    const b = analyseCiting("Series of 78 [1], 72 [2] and 169 eyes [3] improved.", [1, 2, 3]);
    expect(b.calls.map((c) => c.numerals)).toEqual([["78"], ["72"], ["169"]]);
    // A call standing alone after the stop takes the sentence before it; a call
    // glued after a stop ends that sentence.
    const c = analyseCiting("Rates vary tenfold among 54 eyes. [1]. Next. Covered 100 eyes.[2] The definition differs in 12 ways.", [1, 2]);
    expect(c.calls[0]!.claim).toContain("54 eyes");
    expect(c.calls[1]!.numerals).toEqual(["100"]);
  });

  it("reads parenthesised and superscript calls, but not figures or exponents", () => {
    expect(detectStyle("Seen in 40 eyes (1). Also (2,3). Not (2019) nor (13 %).", 3)).toBe("parentheses");
    const p = analyseCiting("Seen in 40 eyes (1). Also in 30 eyes (2,3). Not (2019) nor (3) % here.", [1, 2, 3]);
    expect(p.calls.map((c) => c.numbers)).toEqual([[1], [2, 3]]);
    const s = analyseCiting("Rupture is rare¹. Others agree²⁻³. Area 4 mm². Cited <sup>1,2</sup> and ^3^.", [1, 2, 3]);
    expect(s.style).toBe("superscript");
    expect(s.calls.map((c) => c.numbers)).toEqual([[1], [2, 3], [1, 2], [3]]);
    expect(analyseCiting("No calls at all here.", [1]).style).toBe("none");
  });

  it("matches a figure as a whole number", () => {
    expect(numeralIn("13", "rates of 13 %")).toBe(true);
    expect(numeralIn("13", "rates of 130 and 1.3")).toBe(false);
    expect(numeralIn("2.8", "2,8 millions")).toBe(true);
    expect(numeralIn("2853", "2,853 procedures")).toBe(true);
  });
});

describe("refcheck — comparing with the record", () => {
  it("expands abbreviated page ranges and scores titles", () => {
    expect(expandPages("157-62")).toBe("157-162");
    expect(expandPages("e75-e79")).toBe("e75-e79");
    expect(expandPages("143")).toBe("143");
    expect(titleSimilarity("Risk factors!", "risk  FACTORS")).toBe(1);
    expect(titleSimilarity("", "x")).toBe(0);
    expect(vancouverAuthors(["A B", "C D", "E F", "G H", "I J", "K L", "M N"])).toBe("A B, C D, E F, G H, I J, K L, et al.");
  });

  it("diffs field by field: match, mismatch with the expected value, missing", () => {
    const ref = parseVancouver(REFS[1]!.slice(3), 2);
    const rec = {
      via: "pubmed" as const,
      how: "doi" as const,
      pmid: "34074994",
      authors: ["Segers MHM", "Behndig A", "van den Biggelaar FJHM", "Brocato L", "Henry YP", "Nuijts RMMA", "Lundström M"],
      title: "Risk factors for posterior capsule rupture",
      journal: "J Cataract Refract Surg",
      year: "2022",
      volume: "48",
      issue: "1",
      pages: "51-5",
      doi: "10.1097/J.JCRS.0000000000000708",
      url: "https://pubmed.ncbi.nlm.nih.gov/34074994/",
    };
    const d = Object.fromEntries(diffReference(ref, rec).map((f) => [f.field, f]));
    expect(d.authors).toMatchObject({ status: "match", note: expect.stringMatching(/style: 3 author/) });
    expect(d.year).toMatchObject({ status: "mismatch", cited: "2021", expected: "2022" });
    expect(d.pages!.status).toBe("match");
    expect(d.doi!.status).toBe("match");
    const wrong = diffReference({ ...ref, authors: ["Segers MH", "Behnig A"], etAl: false, title: "Other", journal: "Other J", doi: undefined }, rec);
    const w = Object.fromEntries(wrong.map((f) => [f.field, f]));
    expect(w.authors!.status).toBe("mismatch");
    expect(w.authors!.note).toMatch(/initials "MH" — record has "MHM"/);
    expect(w.authors!.note).toMatch(/"Behnig A" — record has "Behndig A"/);
    expect(w.authors!.note).toMatch(/2 of 7 authors listed and no "et al\."/);
    expect(w.title).toMatchObject({ status: "mismatch", note: expect.stringMatching(/% of words in common/) });
    expect(w.journal).toMatchObject({ status: "mismatch", note: "the NLM abbreviation is the PubMed one" });
    expect(w.doi).toMatchObject({ status: "missing", expected: "10.1097/J.JCRS.0000000000000708" });
    const none = diffReference({ ...ref, authors: [] }, { ...rec, authors: [] });
    expect(none[0]).toMatchObject({ field: "authors", status: "match" });
    const absent = diffReference({ ...ref, authors: [] }, rec);
    expect(absent[0]).toMatchObject({ field: "authors", status: "missing" });
    const extra = diffReference({ ...ref, authors: [...rec.authors, "Extra Z"], etAl: false }, rec);
    expect(extra[0]!.note).toMatch(/"Extra Z" is not an author/);
    const short = diffReference({ ...ref, authors: ["Segers MHM"], etAl: true }, { ...rec, authors: ["Segers MHM", "Behndig A"] });
    expect(short[0]!.note).toMatch(/"et al\." although the record has only 2/);
  });
});

describe("refcheck — resolving (mocked E-utilities, Crossref, doi.org)", () => {
  it("resolves by ecitmatch, by DOI, falls back to Crossref, and checks every DOI", async () => {
    const calls: string[] = [];
    network(calls);
    const refs = parseReferences(REFS.join("\n"));
    const r = await resolveReferences(refs);
    expect(r.records.get(1)).toMatchObject({ via: "pubmed", how: "ecitmatch", pmid: "36211319", pmcid: "PMC9535910", year: "2022" });
    expect(r.records.get(2)).toMatchObject({ via: "pubmed", how: "doi", pmid: "34074994" });
    expect(r.records.get(2)!.abstract).toContain("RESULTS: Of 2.8 million procedures, 1.1% had a rupture & more.");
    expect(r.records.get(3)).toMatchObject({ via: "crossref", how: "doi", journal: "Some Journal", authors: ["Doe J"], abstract: "We followed 120 eyes." });
    expect(r.records.has(4)).toBe(false);
    expect(r.doiChecks.get("10.9999/fake")).toEqual({ doi: "10.9999/fake", resolves: false });
    expect(r.doiChecks.get("10.4103/sjopt.sjopt_186_21")).toMatchObject({ resolves: true, target: "https://publisher.test/x" });
    // One batched esummary and one batched efetch for every PMID.
    expect(calls.filter((u) => u.includes("esummary.fcgi"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("efetch.fcgi"))).toHaveLength(1);
  });

  it("keeps a Crossref bibliographic hit only when its title is the cited one, and says when doi.org cannot answer", async () => {
    installFetchMock(() => json({ message: { items: [{ DOI: "10.1/x", title: ["An unfindable work"], issued: { "date-parts": [[2018]] } }] } }));
    const hit = await crossrefBibliographic(parseVancouver(REFS[3]!.slice(3), 4));
    expect(hit).toMatchObject({ via: "crossref", how: "bibliographic", doi: "10.1/x", year: "2018" });
    installFetchMock(() => ({ status: 500, body: "" }));
    expect(await checkDoi("10.1/x")).toEqual({ doi: "10.1/x", resolves: undefined });
  });

  it("rejects a PubMed title hit whose title does not agree", async () => {
    installFetchMock((url) => {
      if (url.includes("esearch.fcgi")) return json({ esearchresult: { idlist: ["999"] } });
      if (url.includes("esummary.fcgi")) return json({ result: { "999": { title: "A completely different article", authors: [] } } });
      if (url.includes("efetch.fcgi")) return { body: "<PubmedArticleSet/>", contentType: "application/xml" };
      return json({ message: { items: [] } });
    });
    const r = await resolveReferences([parseVancouver("Nobody X. An unfindable work. Nowhere J. 2018.", 1)]);
    expect(r.records.size).toBe(0);
  });
});

describe("refcheck — the whole run", () => {
  it("writes refcheck.json, REFCHECK.md and a dossier where S<n> is reference n, which `check` accepts", async () => {
    network();
    const dir = mkdtempSync(join(tmpdir(), "us-refcheck-"));
    try {
      const doc = join(dir, "thesis.md");
      writeFileSync(doc, [...BODY, "", "## References", "", ...REFS].join("\n"));
      const out = join(dir, "out");
      const r = await runRefcheck({ refs: doc, out });
      expect(r.summary).toMatchObject({
        references: 4,
        resolved: 3,
        viaPubmed: 2,
        viaCrossref: 1,
        unresolved: 1,
        doisCited: 3,
        doisBroken: 1,
        uncited: 1,
        unknownCalls: 1,
        outOfOrder: 2,
      });
      expect(r.citingFile).toBe(doc);
      const byN = Object.fromEntries(r.references.map((e) => [e.n, e]));
      expect(byN[1]!.status).toBe("ok");
      expect(byN[2]!.status).toBe("discrepancies");
      expect(byN[3]!.fields.find((f) => f.field === "doi")).toMatchObject({ status: "mismatch", note: "does not resolve on doi.org" });
      expect(byN[4]!.status).toBe("unresolved");
      expect(byN[2]!.claims[0]!.numerals).toEqual([{ value: "2.8", status: "found" }]);
      expect(byN[3]!.claims[0]!.numerals).toEqual([{ value: "120", status: "found" }]);
      expect(byN[1]!.claims).toEqual([]); // its citing passage states no figure
      // The dossier: ids follow the reference numbers, with a gap for the unresolved one.
      const sources = JSON.parse(readFileSync(join(out, "sources.json"), "utf8")) as Source[];
      expect(sources.map((s) => s.id)).toEqual(["S1", "S2", "S3"]);
      expect(sources[0]!.url).toBe("https://pubmed.ncbi.nlm.nih.gov/36211319/");
      expect(readFileSync(join(out, "sources", "S2.md"), "utf8")).toContain("Of 2.8 million procedures");
      expect(readFileSync(join(out, "DOSSIER.md"), "utf8")).toContain("## Report template (verification)");
      expect(existsSync(join(out, "refs.bib"))).toBe(true);
      const md = readFileSync(join(out, "REFCHECK.md"), "utf8");
      for (const h of [
        "## Verdict",
        "## Reference-by-reference table",
        "## Discrepancies",
        "## Claims checked against their sources",
        "## Not verifiable",
        "## Open questions",
      ]) {
        expect(md).toContain(h);
      }
      expect(md).toMatch(/\| 2 \| discrepancies \| PMID 34074994 \|/);
      expect(md).toContain("**year**: cited `2021` — record has `2022`");
      expect(md).toContain("**Never cited:** [4]");
      expect(md).toContain("**Called but not in the list:** [5]");
      expect(md).toContain("[1] after [2]");
      // A report written from the dossier goes through `check`.
      writeFileSync(
        join(out, "REPORT.md"),
        "## Verdict\n\nThe registry study reports 2.8 million procedures in its abstract [S2].\n\n## Open questions\n\n- The full text was not read [M].\n",
      );
      expect(runCheck(out).ok).toBe(true);
      // Re-running into the same dir is allowed; into another dossier is not.
      await runRefcheck({ refs: doc, out, offline: true });
      writeFileSync(join(dir, "sources.json"), "[]");
      await expect(runRefcheck({ refs: doc, out: dir, offline: true })).rejects.toThrow(/already holds a dossier/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("offline: parses and reads the citing text, looks nothing up, writes no dossier", async () => {
    const spy = installFetchMock(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), "us-refcheck-"));
    try {
      const refs = join(dir, "refs.txt");
      const citing = join(dir, "body.md");
      writeFileSync(refs, REFS.join("\n"));
      writeFileSync(citing, BODY.join("\n"));
      const r = await runRefcheck({ refs, citing, out: join(dir, "o"), offline: true });
      expect(spy).not.toHaveBeenCalled();
      expect(r.offline).toBe(true);
      expect(r.references.every((e) => e.status === "not-checked")).toBe(true);
      expect(existsSync(join(dir, "o", "sources.json"))).toBe(false);
      const md = renderRefcheckMarkdown(r);
      expect(md).toContain("**Offline run**");
      expect(md).toContain("_Not checked (offline)._");
      expect(md).toContain("offline run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a .docx, says when there is no citing text or no list, and refuses an empty list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-refcheck-"));
    try {
      const docx = join(dir, "thesis.docx");
      writeFileSync(docx, makeDocx([...BODY.map((l) => l.replace(/^# /, "")), "# References", ...REFS]));
      expect(await readDocumentText(docx)).toContain("2,8 millions");
      const r = await runRefcheck({ refs: docx, out: join(dir, "a"), offline: true });
      expect(r.references).toHaveLength(4);
      expect(r.citing?.calls).toBe(4);
      const listOnly = join(dir, "list.txt");
      writeFileSync(listOnly, REFS.join("\n"));
      const r2 = await runRefcheck({ refs: listOnly, out: join(dir, "b"), offline: true });
      expect(r2.citing).toBeUndefined();
      expect(renderRefcheckMarkdown(r2)).toContain("No citing text");
      const empty = join(dir, "empty.txt");
      writeFileSync(empty, "nothing here");
      await expect(runRefcheck({ refs: empty, offline: true })).rejects.toThrow(/no reference found/);
      await expect(readDocumentText(join(dir, "missing.txt"))).rejects.toThrow(/file not found/);
      const notOffice = join(dir, "x.docx");
      writeFileSync(notOffice, "not a zip");
      await expect(readDocumentText(notOffice)).rejects.toThrow(/could not read/);
      const noCalls = join(dir, "nocalls.md");
      writeFileSync(noCalls, "A body without any call.");
      const r3 = await runRefcheck({ refs: listOnly, citing: noCalls, out: join(dir, "c"), offline: true });
      expect(r3.notes.join(" ")).toMatch(/No citation call/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes no dossier when nothing resolves", async () => {
    installFetchMock((url) =>
      url.includes("esearch") ? json({ esearchresult: { idlist: [] } }) : url.includes("crossref") ? json({ message: { items: [] } }) : undefined,
    );
    const dir = mkdtempSync(join(tmpdir(), "us-refcheck-"));
    try {
      const refs = join(dir, "refs.txt");
      writeFileSync(refs, REFS[3]!);
      const r = await runRefcheck({ refs, out: join(dir, "o") });
      expect(r.summary.unresolved).toBe(1);
      expect(r.notes.join(" ")).toMatch(/no dossier was written/);
      expect(renderRefcheckMarkdown(r)).toContain("not found on PubMed or Crossref");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// In-process CLI capture, as in cli-ingest.test.ts.
async function run(argv: string[]): Promise<{ out: string; err: string; exit?: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
    out.push(String(c));
    return true;
  }) as never);
  const e = vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => {
    err.push(String(c));
    return true;
  }) as never);
  const x = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  let exit: number | undefined;
  try {
    await main(argv);
  } catch (er) {
    const m = /^exit:(\d+)$/.exec((er as Error).message);
    if (!m) throw er;
    exit = Number(m[1]);
  } finally {
    o.mockRestore();
    e.mockRestore();
    x.mockRestore();
  }
  return { out: out.join(""), err: err.join(""), exit };
}

describe("refcheck — CLI and MCP", () => {
  it("prints a summary, or the JSON, and points `--mode refcheck` at the command", async () => {
    network();
    const dir = mkdtempSync(join(tmpdir(), "us-refcheck-"));
    try {
      const doc = join(dir, "thesis.md");
      writeFileSync(doc, [...BODY, "## References", ...REFS].join("\n"));
      const r = await run(["refcheck", "--refs", doc, "--out", join(dir, "o")]);
      expect(r.err).toMatch(/4 reference\(s\) in thesis\.md/);
      expect(r.err).toMatch(/resolved: 3 \(2 PubMed, 1 Crossref\)/);
      expect(r.err).toMatch(/dossier: .* source S<n> is reference n/);
      const j = await run(["refcheck", "--refs", doc, "--out", join(dir, "o"), "--json", "--offline"]);
      expect(JSON.parse(j.out).summary.references).toBe(4);
      const off = await run(["refcheck", "--refs", join(dir, "thesis.md"), "--citing", doc, "--out", join(dir, "p"), "--offline"]);
      expect(off.err).toMatch(/offline: {2}parsed only/);
      const listOnly = join(dir, "list.txt");
      writeFileSync(listOnly, REFS.join("\n"));
      expect((await run(["refcheck", "--refs", listOnly, "--out", join(dir, "q"), "--offline"])).err).toMatch(/citing: {3}none/);
      expect((await run(["refcheck"])).exit).toBe(1);
      expect((await run(["refcheck", "--refs", doc, "--stdout"])).exit).toBeUndefined();
      expect(process.exitCode).toBe(2);
      process.exitCode = 0;
      const q = await run(["queries", "--mode", "refcheck"]);
      expect(q.out).toMatch(/`refcheck` command, not a mode/);
      const g = await run(["gather", "--q", "x", "--mode", "refcheck"]);
      expect(g.exit).toBe(1);
      expect(g.err).toMatch(/ultrasearch refcheck --refs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ultrasearch_refcheck returns the summary and the references to look at", async () => {
    network();
    const dir = mkdtempSync(join(tmpdir(), "us-refcheck-"));
    try {
      const doc = join(dir, "thesis.md");
      writeFileSync(doc, [...BODY, "## References", ...REFS].join("\n"));
      const res = await callTool("ultrasearch_refcheck", { refs: doc, out: join(dir, "o") });
      const body = JSON.parse(res.text);
      expect(body.summary.resolved).toBe(3);
      expect(body.issues.map((i: { n: number }) => i.n)).toEqual([2, 3, 4]);
      expect(body.issues.find((i: { n: number }) => i.n === 3).doi).toBe("does not resolve");
      expect(body.next).toMatch(/source S<n> is reference n/);
      const off = JSON.parse((await callTool("ultrasearch_refcheck", { refs: doc, out: join(dir, "p"), offline: true })).text);
      expect(off.next).not.toMatch(/S<n>/);
      await expect(callTool("ultrasearch_refcheck", { refs: "relative.txt" })).rejects.toThrow(/absolute path/);
      await expect(callTool("ultrasearch_refcheck", { refs: join(dir, "nope.txt") })).rejects.toThrow(/no file at/);
      await expect(callTool("ultrasearch_refcheck", { refs: doc, citing: join(dir, "nope.md") })).rejects.toThrow(/no file at/);
      const empty = join(dir, "empty.txt");
      writeFileSync(empty, "nothing");
      await expect(callTool("ultrasearch_refcheck", { refs: empty })).rejects.toThrow(/no reference found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
