import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { redirectedHome, searchPageOf } from "../src/listing.js";
import { identityKeys } from "../src/identity.js";
import { addSource, addSources } from "../src/enrich.js";
import { runGather } from "../src/gather.js";
import { writeFixtureDossier } from "./dossierfix.js";
import { installFetchMock, routes } from "./fetchmock.js";
import type { GatherOptions, Source } from "../src/types.js";

// Pages that are not documents (a results page, a dead link answered by the
// home page), and one paper banked under several addresses — all three found
// by a run on a real thesis.

afterEach(() => vi.unstubAllGlobals());

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-listing-"));
}
function sourcesOf(dir: string): Source[] {
  return JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
}
const ARTICLE = `<article><h1>Carlevale lens outcomes</h1><p>${"Forty-one eyes were followed for four years after Carlevale implantation with two scleral pockets. ".repeat(6)}</p></article>`;
const ABSTRACT = {
  contentType: "text/plain",
  body: [
    "1. J Cataract Refract Surg. 2022;48(3):301-308. doi: 10.1097/j.jcrs.0000000000000777.",
    "",
    "Carlevale sutureless scleral fixation: four-year outcomes.",
    "",
    `${"We followed forty-one eyes after Carlevale implantation and report anchor exteriorisation and its complications. ".repeat(3)}`,
    "",
    "DOI: 10.1097/j.jcrs.0000000000000777",
    "PMID: 35000001",
  ].join("\n"),
};

describe("searchPageOf", () => {
  it("names the results pages of search engines and databases", () => {
    for (const u of [
      "https://pubmed.ncbi.nlm.nih.gov/?term=carlevale",
      "https://www.ncbi.nlm.nih.gov/pmc/?term=carlevale",
      "https://europepmc.org/search?query=carlevale",
      "https://www.google.com/search?q=carlevale",
      "https://scholar.google.com/scholar?q=carlevale",
      "https://duckduckgo.com/?q=carlevale",
    ]) {
      expect(searchPageOf(u), u).toMatch(/is a search results page/);
    }
  });

  it("leaves documents alone, query strings included", () => {
    for (const u of [
      "https://pubmed.ncbi.nlm.nih.gov/35000001/",
      "https://example.test/article?id=4",
      "https://example.test/2024/carlevale-review?q=carlevale",
      "https://example.test/search-engines-explained",
      "not a url",
    ]) {
      expect(searchPageOf(u), u).toBeUndefined();
    }
  });
});

describe("redirectedHome", () => {
  it("is a deep link that landed on the site's root", () => {
    expect(redirectedHome("https://www.escrs.org/guidelines/iol-2019.pdf", "https://www.escrs.org/")).toBe(true);
    expect(redirectedHome("https://site.test/en/page", "https://site.test/en/")).toBe(true);
  });
  it("is not a root asked for, an ordinary redirect, or no redirect", () => {
    expect(redirectedHome("https://site.test/", "https://site.test/")).toBe(false);
    expect(redirectedHome("http://site.test/a", "https://site.test/a/")).toBe(false);
    expect(redirectedHome("https://site.test/a", undefined)).toBe(false);
    expect(redirectedHome("https://site.test/a", "https://site.test/?redirected=1")).toBe(false);
  });
});

describe("fetch / ingest refuse what is not a document", () => {
  it("refuses a PubMed search URL instead of banking PubMed's interface", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    const spy = installFetchMock(() => ({ body: "<p>Create a new collection. Save citations to file.</p>" }));
    const r = await addSources(dir, ["https://pubmed.ncbi.nlm.nih.gov/?term=carlevale+scleral"]);
    expect(r.added).toBe(0);
    expect(r.results[0]!.note).toMatch(/is a search results page \(term=carlevale scleral\), not a document/);
    expect(spy).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a deep link that redirected to the home page, after asking the archive", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock((url) =>
      url.includes("escrs.org")
        ? { url: "https://www.escrs.org/", body: `<main><h1>ESCRS</h1><p>${"Welcome to the society's home page and its many events. ".repeat(10)}</p></main>` }
        : undefined,
    );
    const r = await addSource(dir, "https://www.escrs.org/guidelines/old-iol-guideline", {});
    expect(r.added).toBe(false);
    expect(r.note).toMatch(/redirected to the site's home page \(https:\/\/www\.escrs\.org\/\) — the document is gone/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers the page's own title to a host name given as the title", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(() => ({ body: `<title>Carlevale lens outcomes</title>${ARTICLE}` }));
    await addSources(dir, [{ url: "https://journal.test/carlevale", title: "journal.test" }]);
    expect(sourcesOf(dir)[1]!.title).toBe("Carlevale lens outcomes");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("one paper, several addresses", () => {
  it("keys a source by its DOI, PMID and PMCID", () => {
    expect(identityKeys("https://doi.org/10.1097/J.JCRS.0000000000000777")).toEqual(["doi:10.1097/j.jcrs.0000000000000777"]);
    expect(identityKeys("https://journals.test/doi/full/10.1016/abc?x=1")).toEqual(["doi:10.1016/abc"]);
    expect(identityKeys("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/")).toEqual(["pmcid:PMC123"]);
    expect(identityKeys("https://pubmed.ncbi.nlm.nih.gov/35000001/", undefined, ABSTRACT.body).sort()).toEqual([
      "doi:10.1097/j.jcrs.0000000000000777",
      "pmid:35000001",
    ]);
    expect(identityKeys("https://publisher.test/a", { doi: "10.1016/ABC." })).toEqual(["doi:10.1016/abc"]);
  });

  it("ingest: the PubMed page of a paper already banked by its DOI is the same source", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(
      routes([
        ["eutils.ncbi.nlm.nih.gov", ABSTRACT],
        ["doi.org", { body: ARTICLE }],
        [
          "rest/PMC777/fullTextXML",
          {
            contentType: "application/xml",
            body: `<article><body><p>${"Carlevale lenses stayed in place in most eyes at four years of follow-up. ".repeat(6)}</p></body></article>`,
          },
        ],
      ]),
    );
    const first = await addSource(dir, "https://doi.org/10.1097/j.jcrs.0000000000000777", {});
    expect(first.added).toBe(true);
    const twin = await addSource(dir, "https://pubmed.ncbi.nlm.nih.gov/35000001/", {});
    expect(twin).toMatchObject({ id: first.id, added: false });
    expect(twin.note).toMatch(/the same paper: .*doi:10\.1097\/j\.jcrs\.0000000000000777/);
    // and the legacy PMC host is the current one
    const pmc = await addSources(dir, ["https://pmc.ncbi.nlm.nih.gov/articles/PMC777/", "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC777/"]);
    expect(pmc.results[1]!.note ?? "").toMatch(/already in dossier/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("gather: merges the PMC page's two hosts, and a DOI with the PubMed record that names it", async () => {
    const dir = scratch();
    installFetchMock(
      routes([
        ["eutils.ncbi.nlm.nih.gov", ABSTRACT],
        ["doi.org/10.1097", { status: 403, body: "" }],
        [
          "rest/PMC4444/fullTextXML",
          {
            contentType: "application/xml",
            body: `<article><body><p>${"Carlevale lenses stayed in place in most eyes at four years of follow-up. ".repeat(6)}</p></body></article>`,
          },
        ],
      ]),
    );
    const opts: GatherOptions = {
      question: "Carlevale scleral fixation outcomes",
      mode: "topic",
      depth: "standard",
      perSource: 6,
      lang: "en",
      webEngine: "auto",
      excludeDomains: [],
      json: false,
      backends: ["claude"],
      out: dir,
      webResults: [
        {
          url: "https://doi.org/10.1097/j.jcrs.0000000000000777",
          title: "Carlevale four-year outcomes",
          snippet: "Carlevale scleral fixation outcomes at four years.",
        },
        { url: "https://pubmed.ncbi.nlm.nih.gov/35000001/" },
        { url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC4444/" },
        { url: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4444/" },
      ],
    };
    const r = await runGather(opts);
    const urls = r.sources.map((s) => s.url);
    expect(urls.filter((u) => u.includes("PMC4444"))).toEqual(["https://pmc.ncbi.nlm.nih.gov/articles/PMC4444/"]);
    expect(urls).toContain("https://pubmed.ncbi.nlm.nih.gov/35000001/");
    expect(urls).not.toContain("https://doi.org/10.1097/j.jcrs.0000000000000777");
    const pubmed = r.sources.find((s) => s.url.includes("35000001"))!;
    expect(pubmed.meta?.alsoAt).toEqual(["https://doi.org/10.1097/j.jcrs.0000000000000777"]);
    expect(r.manifest.notes.join("\n")).toMatch(/Merged 1 source\(s\) that were the same paper/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("gather: drops a search results page and says so", async () => {
    const dir = scratch();
    installFetchMock(() => ({ body: ARTICLE }));
    const r = await runGather({
      question: "Carlevale scleral fixation outcomes",
      mode: "topic",
      depth: "standard",
      perSource: 6,
      lang: "en",
      webEngine: "auto",
      excludeDomains: [],
      json: false,
      backends: ["claude"],
      out: dir,
      webResults: [{ url: "https://pubmed.ncbi.nlm.nih.gov/?term=carlevale" }, { url: "https://journal.test/carlevale" }],
    });
    expect(r.sources.map((s) => s.url)).toEqual(["https://journal.test/carlevale"]);
    expect(r.manifest.notes.join("\n")).toMatch(/Dropped 1 search results page\(s\)/);
    rmSync(dir, { recursive: true, force: true });
  });
});
