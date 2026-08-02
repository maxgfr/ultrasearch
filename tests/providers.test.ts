import { describe, expect, it } from "vitest";
import { pubmedAbstractUrl, resolveProvider } from "../src/providers.js";

const EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

describe("resolveProvider", () => {
  it("leaves an unknown url alone, with no alternate", () => {
    expect(resolveProvider("https://example.test/a/b?x=1")).toEqual({ citeUrl: "https://example.test/a/b?x=1" });
  });

  it("pairs a PubMed landing page with its E-utilities abstract", () => {
    const r = resolveProvider("https://pubmed.ncbi.nlm.nih.gov/34397876/");
    expect(r.citeUrl).toBe("https://pubmed.ncbi.nlm.nih.gov/34397876/");
    expect(r.textUrl).toBe(pubmedAbstractUrl("34397876"));
    expect(r.reject).toBeUndefined();
  });

  it("normalizes a PubMed landing page without its trailing slash", () => {
    expect(resolveProvider("http://www.pubmed.ncbi.nlm.nih.gov/32507620").citeUrl).toBe("https://pubmed.ncbi.nlm.nih.gov/32507620/");
  });

  it("cites the landing page for a single-id efetch endpoint", () => {
    const r = resolveProvider(`${EFETCH}?db=pubmed&id=42089999&rettype=abstract&retmode=text`);
    expect(r.citeUrl).toBe("https://pubmed.ncbi.nlm.nih.gov/42089999/");
    expect(r.textUrl).toBe(pubmedAbstractUrl("42089999"));
  });

  it("cites the landing page for an esummary endpoint too, and normalizes retmode", () => {
    const r = resolveProvider("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=34397876");
    expect(r.citeUrl).toBe("https://pubmed.ncbi.nlm.nih.gov/34397876/");
    expect(r.textUrl).toBe(pubmedAbstractUrl("34397876")); // always the plain-text abstract, never the JSON
  });

  it("refuses an esearch query — it points at a result list, not a document", () => {
    const r = resolveProvider("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=carlevale+iol");
    expect(r.reject).toMatch(/esearch query, not a document/);
  });

  it("maps a PMC endpoint and a PMC page onto the same landing url", () => {
    expect(resolveProvider(`${EFETCH}?db=pmc&id=PMC7181535&retmode=xml`).citeUrl).toBe("https://pmc.ncbi.nlm.nih.gov/articles/PMC7181535/");
    expect(resolveProvider(`${EFETCH}?db=pmc&id=7181535`).citeUrl).toBe("https://pmc.ncbi.nlm.nih.gov/articles/PMC7181535/");
    expect(resolveProvider("https://pmc.ncbi.nlm.nih.gov/articles/PMC7181535/").citeUrl).toBe("https://pmc.ncbi.nlm.nih.gov/articles/PMC7181535/");
  });

  it("cites the arXiv abstract page but keeps the PDF as the text source", () => {
    const r = resolveProvider("https://arxiv.org/pdf/2401.01234v2.pdf");
    expect(r.citeUrl).toBe("https://arxiv.org/abs/2401.01234v2");
    expect(r.textUrl).toBe("https://arxiv.org/pdf/2401.01234v2.pdf");
    expect(resolveProvider("https://arxiv.org/pdf/2401.01234").citeUrl).toBe("https://arxiv.org/abs/2401.01234");
  });

  it("leaves an E-utilities db it knows nothing about untouched", () => {
    const url = `${EFETCH}?db=nuccore&id=U49845&rettype=gb`;
    expect(resolveProvider(url)).toEqual({ citeUrl: url });
  });

  it("survives a malformed url", () => {
    expect(resolveProvider("not a url").citeUrl).toBe("not a url");
  });
});
