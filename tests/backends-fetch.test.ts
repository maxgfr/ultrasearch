import { afterEach, describe, expect, it, vi } from "vitest";
import { htmlToText, decodeEntities, htmlTitle, bestExcerpt, capExtract, fetchAndExtract, httpGet, httpJson } from "../src/backends/fetch.js";
import { installFetchMock, routes } from "./fetchmock.js";

afterEach(() => vi.unstubAllGlobals());

describe("Accept-Language header", () => {
  it("httpGet sends accept-language only when opts.acceptLanguage is given", async () => {
    const spy = installFetchMock(() => ({ body: "ok" }));
    await httpGet("https://x.test/a", { acceptLanguage: "de-DE,de;q=0.9,en;q=0.5" });
    await httpGet("https://x.test/b");
    expect((spy.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ "accept-language": "de-DE,de;q=0.9,en;q=0.5" });
    expect((spy.mock.calls[1]![1] as RequestInit).headers).not.toHaveProperty("accept-language");
  });

  it("httpJson sends accept-language when given", async () => {
    const spy = installFetchMock(() => ({ body: "{}", contentType: "application/json" }));
    await httpJson("GET", "https://x.test/j", undefined, { acceptLanguage: "fr-FR,fr;q=0.9,en;q=0.5" });
    expect((spy.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ "accept-language": "fr-FR,fr;q=0.9,en;q=0.5" });
  });
});

describe("htmlToText", () => {
  it("strips script/style/nav and keeps heading + prose", () => {
    const html = `<html><head><title>T</title></head><body>
      <nav>menu junk</nav>
      <script>var x = 1;</script>
      <h2>Configuration</h2>
      <p>The timeout option controls retries.</p>
      <footer>copyright</footer></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("## Configuration");
    expect(text).toContain("The timeout option controls retries.");
    expect(text).not.toContain("menu junk");
    expect(text).not.toContain("var x");
    expect(text).not.toContain("copyright");
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex references", () => {
    expect(decodeEntities("a &amp; b &#39;x&#39; &#x27;y&#x27;")).toBe("a & b 'x' 'y'");
  });
});

describe("htmlTitle", () => {
  it("extracts and decodes the title", () => {
    expect(htmlTitle("<title>Foo &amp; Bar</title>")).toBe("Foo & Bar");
    expect(htmlTitle("<body>no title</body>")).toBeUndefined();
  });
});

describe("bestExcerpt", () => {
  it("returns the window most relevant to the question", () => {
    const text = ["Intro line about nothing.", "## Token bucket", "A token bucket refills tokens at a steady rate.", "Unrelated trailing line."].join("\n");
    const ex = bestExcerpt(text, "how does a token bucket refill");
    expect(ex.toLowerCase()).toContain("token bucket");
  });
});

describe("capExtract", () => {
  it("keeps everything on deep, truncates on standard", () => {
    const long = "x\n".repeat(10000);
    expect(capExtract(long, "deep")).toBe(long);
    expect(capExtract(long, "standard").length).toBeLessThan(long.length);
    expect(capExtract(long, "standard")).toContain("… [truncated]");
  });
});

describe("fetchAndExtract", () => {
  it("returns cleaned text + title for an html page", async () => {
    installFetchMock(routes([["example.com", { body: "<title>Doc</title><h1>Hi</h1><p>body text</p>" }]]));
    const r = await fetchAndExtract("https://example.com/x");
    expect(r.title).toBe("Doc");
    expect(r.text).toContain("body text");
  });
  it("returns a note (not a throw) on a failed fetch", async () => {
    installFetchMock(() => ({ status: 500, body: "" }));
    const r = await fetchAndExtract("https://example.com/x");
    expect(r.text).toBe("");
    expect(r.note).toMatch(/Could not fetch/);
  });
});
