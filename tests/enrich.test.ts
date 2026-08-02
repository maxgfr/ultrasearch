import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addSource } from "../src/enrich.js";
import { writeFixtureDossier } from "./dossierfix.js";
import { installFetchMock, routes } from "./fetchmock.js";
import type { Source } from "../src/types.js";

afterEach(() => vi.unstubAllGlobals());

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-enrich-"));
}

describe("addSource", () => {
  it("allocates the next S# id, writes the extract and appends to sources.json", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    installFetchMock(routes([["new.test", { body: "<title>New</title><p>fresh content about limits</p>" }]]));
    const r = await addSource(dir, "https://new.test/page", { question: "rate limiting" });
    expect(r).toMatchObject({ id: "S3", added: true });
    expect(existsSync(join(dir, "sources/S3.md"))).toBe(true);

    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources).toHaveLength(3);
    expect(sources[2]!.backend).toBe("claude");
    expect(sources[2]!.url).toBe("https://new.test/page");
    rmSync(dir, { recursive: true, force: true });
  });

  it("dedupes a url already present, returning the existing id", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(routes([["dup.test", { body: "<p>x</p>" }]]));
    const first = await addSource(dir, "https://dup.test/a", {});
    expect(first.added).toBe(true);
    const again = await addSource(dir, "https://dup.test/a/", {}); // same canonical url
    expect(again.added).toBe(false);
    expect(again.id).toBe(first.id);
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources).toHaveLength(2); // S1 fixture + first add; no dup
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a note (no id) when the page can't be fetched", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(() => ({ status: 500, body: "" }));
    const r = await addSource(dir, "https://gone.test/x", {});
    expect(r.added).toBe(false);
    expect(r.id).toBe("");
    expect(r.note).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });
});

// A pinned source is cited verbatim, so what `fetch --url` stores has to BE the
// document. These cover the two ways that used to fail silently: an anti-bot
// interstitial banked as full text, and a data endpoint banked as the citation.
const CAPTCHA = {
  body: "<title>Checking your browser - reCAPTCHA</title><p>Checking your browser before accessing pubmed.ncbi.nlm.nih.gov. Click here if you are not automatically redirected after 5 seconds.</p>",
};
const ABSTRACT = {
  contentType: "text/plain",
  body: [
    "1. Ophthalmology. 2020 Sep;127(9):1234-1258. doi: 10.1016/j.ophtha.2020.03.005.",
    "Epub 2020 Jun 5.",
    "",
    "Intraocular Lens Implantation in the Absence of Zonular Support: An Outcomes and",
    "Safety Update.",
    "",
    "Shen JF, Deng S, Hammersmith KM.",
    "",
    "PURPOSE: To review the published literature on the visual acuity results and",
    "complications of different surgical techniques for intraocular lens implantation",
    "in the absence of zonular support.",
  ].join("\n"),
};

describe("addSource — walls and API endpoints", () => {
  it("refuses an anti-bot interstitial instead of banking it as the source text", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(routes([["pubmed.ncbi.nlm.nih.gov", CAPTCHA]])); // the abstract endpoint 404s too
    const r = await addSource(dir, "https://pubmed.ncbi.nlm.nih.gov/34397876/", {});
    expect(r).toMatchObject({ id: "", added: false });
    expect(r.note).toMatch(/anti-bot interstitial/);
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources).toHaveLength(1); // nothing added
    rmSync(dir, { recursive: true, force: true });
  });

  it("hydrates a walled page from the provider endpoint while citing the page", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(
      routes([
        ["eutils.ncbi.nlm.nih.gov", ABSTRACT],
        ["pubmed.ncbi.nlm.nih.gov", CAPTCHA],
      ]),
    );
    const r = await addSource(dir, "https://pubmed.ncbi.nlm.nih.gov/34397876/", { question: "intraocular lens" });
    expect(r.added).toBe(true);

    const added = (JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[])[1]!;
    expect(added.url).toBe("https://pubmed.ncbi.nlm.nih.gov/34397876/"); // the page, not the endpoint
    expect(added.meta?.textVia).toContain("efetch.fcgi");
    expect(added.title).toBe("Intraocular Lens Implantation in the Absence of Zonular Support: An Outcomes and Safety Update.");
    expect(readFileSync(join(dir, added.extract), "utf8")).toContain("PURPOSE: To review");
    rmSync(dir, { recursive: true, force: true });
  });

  it("records an E-utilities endpoint under its PubMed landing url", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(routes([["eutils.ncbi.nlm.nih.gov", ABSTRACT]])); // landing 404s, endpoint answers
    const r = await addSource(dir, "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=34397876&rettype=abstract&retmode=text", {});
    expect(r.added).toBe(true);
    const added = (JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[])[1]!;
    expect(added.url).toBe("https://pubmed.ncbi.nlm.nih.gov/34397876/");
    expect(added.domain).toBe("pubmed.ncbi.nlm.nih.gov");
    expect(added.title).not.toContain("efetch.fcgi");
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a url that addresses several records, whoever serves it", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    const spy = installFetchMock(routes([["eutils.ncbi.nlm.nih.gov", ABSTRACT]]));
    const r = await addSource(dir, "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=34397876%2032000520&rettype=abstract", {});
    expect(r).toMatchObject({ id: "", added: false });
    expect(r.note).toMatch(/addresses 2 records/);
    expect(spy).not.toHaveBeenCalled(); // refused before spending a fetch

    const other = await addSource(dir, "https://unknown.api.test/v1/items?ids=a,b,c", {});
    expect(other.note).toMatch(/addresses 3 records/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("derives the citable url from the payload for an endpoint it knows nothing about", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(
      routes([
        [
          "records.test",
          {
            contentType: "application/json",
            body: JSON.stringify({ title: "A study of scleral fixation", doi: "10.1016/j.ophtha.2020.03.005", abstract: "x".repeat(400) }),
          },
        ],
      ]),
    );
    const r = await addSource(dir, "https://records.test/v1/item/77?format=json", {});
    expect(r.added).toBe(true);
    const added = (JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[])[1]!;
    expect(added.url).toBe("https://doi.org/10.1016/j.ophtha.2020.03.005"); // the document's own identifier
    expect(added.meta?.textVia).toBe("https://records.test/v1/item/77?format=json");
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an endpoint whose payload names no document rather than citing the endpoint", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(
      routes([["records.test", { contentType: "application/json", body: JSON.stringify({ count: 3, results: ["a", "b", "c"], note: "y".repeat(400) }) }]]),
    );
    const r = await addSource(dir, "https://records.test/v1/search?format=json", {});
    expect(r).toMatchObject({ id: "", added: false });
    expect(r.note).toMatch(/names no document/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the text from an endpoint but cites the page you reconstructed", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    // A payload that names no document at all — the engine cannot derive
    // anything, but the agent searched and knows where this record lives.
    installFetchMock(
      routes([["records.test", { contentType: "text/plain", body: `An internal record with no identifier of any kind. ${"Body text. ".repeat(40)}` }]]),
    );
    const r = await addSource(dir, "https://records.test/v1/item/77?format=json", { citeUrl: "https://journal.test/articles/scleral-fixation" });
    expect(r.added).toBe(true);
    const added = (JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[])[1]!;
    expect(added.url).toBe("https://journal.test/articles/scleral-fixation");
    expect(added.domain).toBe("journal.test");
    expect(added.meta?.textVia).toBe("https://records.test/v1/item/77?format=json");
    expect(readFileSync(join(dir, added.extract), "utf8")).toContain("no identifier of any kind");
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a reconstructed url that is itself not citable", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    const spy = installFetchMock(routes([["records.test", { body: "<p>x</p>" }]]));
    const r = await addSource(dir, "https://records.test/v1/item/77?format=json", { citeUrl: "https://api.crossref.org/works/10.1/x" });
    expect(r).toMatchObject({ id: "", added: false });
    expect(r.note).toMatch(/not a page a reader can open/);
    expect(spy).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it("tells you to reconstruct the page when the payload names nothing", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(routes([["records.test", { contentType: "text/plain", body: `No identifier here at all. ${"Body. ".repeat(60)}` }]]));
    const r = await addSource(dir, "https://records.test/v1/item/77?format=json", {});
    expect(r.added).toBe(false);
    expect(r.note).toMatch(/pass it as citeUrl/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rescues a consent wall through Firecrawl when no provider endpoint exists", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    const base = "http://fc-enrich.test";
    const markdown = `# Scleral fixation\n\n${"A real browser got past the consent wall and read the page. ".repeat(8)}`;
    installFetchMock((url) => {
      if (url === `${base}/`) return { status: 200, body: "{}" };
      if (url.includes("/scrape"))
        return {
          body: JSON.stringify({ success: true, data: { markdown, metadata: { title: "Scleral fixation", statusCode: 200 } } }),
          contentType: "application/json",
        };
      if (url.includes("walled.test"))
        return { body: "<title>Cookies</title><p>We use cookies to improve your experience. Accept all cookies to continue.</p>" };
      return undefined;
    });
    const r = await addSource(dir, "https://walled.test/article", { firecrawl: base });
    expect(r.added).toBe(true);
    const added = (JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[])[1]!;
    expect(added.title).toBe("Scleral fixation");
    expect(readFileSync(join(dir, added.extract), "utf8")).toContain("got past the consent wall");
    rmSync(dir, { recursive: true, force: true });
  });

  it("dedupes an endpoint against the landing page already in the dossier", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(
      routes([
        ["eutils.ncbi.nlm.nih.gov", ABSTRACT],
        ["pubmed.ncbi.nlm.nih.gov", { body: "<title>Comparison of two techniques</title><p>full record body</p>" }],
      ]),
    );
    const first = await addSource(dir, "https://pubmed.ncbi.nlm.nih.gov/34397876/", {});
    expect(first.added).toBe(true);
    const again = await addSource(dir, "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=34397876&rettype=abstract&retmode=text", {});
    expect(again).toMatchObject({ id: first.id, added: false });
    rmSync(dir, { recursive: true, force: true });
  });
});
