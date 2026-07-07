import { afterEach, describe, expect, it, vi } from "vitest";
import {
  htmlToText,
  decodeEntities,
  htmlTitle,
  bestExcerpt,
  capExtract,
  fetchAndExtract,
  httpGet,
  httpJson,
  extractMainHtml,
  looksLikeJunkExtraction,
  rescueViaWayback,
} from "../src/backends/fetch.js";
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

  it("extracts a content-type-only PDF (no .pdf in the URL) by re-fetching the bytes", async () => {
    const pdf = "%PDF-1.4\nstream\nBT (PdfBodyText) Tj ET\nendstream\n"; // all-ASCII → latin1==utf8
    installFetchMock(routes([["x.test/paper", { body: pdf, contentType: "application/pdf" }]]));
    const r = await fetchAndExtract("https://x.test/paper");
    expect(r.text).toContain("PdfBodyText");
  });

  it("returns a note when a PDF yields no extractable text", async () => {
    installFetchMock(routes([["x.test/scan.pdf", { body: "%PDF-1.4 no text operators here", contentType: "application/pdf" }]]));
    const r = await fetchAndExtract("https://x.test/scan.pdf");
    expect(r.text).toBe("");
    expect(r.note).toMatch(/could not extract text/i);
  });
});

describe("extractMainHtml", () => {
  it("isolates the <main> region and drops the surrounding chrome", () => {
    const main = `<p>${"real article prose about rate limiting and token buckets. ".repeat(20)}</p>`;
    const html = `<body><nav>menu</nav><main>${main}</main><footer>copyright junk</footer></body>`;
    const out = extractMainHtml(html);
    expect(out).toContain("token buckets");
    expect(out).not.toContain("copyright junk");
  });

  it("falls back to the whole document when the matched region is too small", () => {
    const big = "filler ".repeat(400); // makes the page large so a tiny main is <30%
    const html = `<body><p>${big}</p><main>tiny</main></body>`;
    expect(extractMainHtml(html)).toBe(html); // size gate → unchanged
  });
});

describe("looksLikeJunkExtraction", () => {
  it("flags a short consent/JS/anti-bot wall in EN, FR and DE", () => {
    expect(looksLikeJunkExtraction("We use cookies to improve your experience. Accept all cookies")).toMatch(/cookie/i);
    expect(looksLikeJunkExtraction("Please enable JavaScript to continue")).toMatch(/javascript/i);
    expect(looksLikeJunkExtraction("Nous utilisons des cookies pour améliorer.")).toMatch(/fr/);
    expect(looksLikeJunkExtraction("Wir verwenden Cookies auf dieser Seite.")).toMatch(/de/);
  });

  it("never flags a long genuine article, even one that mentions cookies", () => {
    const article = "This article explains HTTP cookies in depth. We use cookies as an example. " + "x ".repeat(1200);
    expect(looksLikeJunkExtraction(article)).toBeUndefined();
  });
});

describe("rescueViaWayback", () => {
  it("returns undefined when the availability API reports no snapshot", async () => {
    installFetchMock(routes([["archive.org/wayback/available", { body: JSON.stringify({ archived_snapshots: {} }), contentType: "application/json" }]]));
    expect(await rescueViaWayback("https://gone.test/x")).toBeUndefined();
  });

  it("returns undefined when the snapshot page is itself a junk/consent wall", async () => {
    installFetchMock((url) => {
      if (url.includes("archive.org/wayback/available"))
        return {
          body: JSON.stringify({ archived_snapshots: { closest: { available: true, url: "https://web.archive.org/snap", timestamp: "2020" } } }),
          contentType: "application/json",
        };
      if (url.includes("web.archive.org/snap")) return { body: "<body>We use cookies. Accept all cookies to continue.</body>" };
      return undefined;
    });
    expect(await rescueViaWayback("https://gone.test/x")).toBeUndefined();
  });

  it("recovers text + snapshot metadata from a usable Wayback snapshot", async () => {
    const body = `<body><article><p>${"recovered archival prose about rate limiting. ".repeat(30)}</p></article></body>`;
    installFetchMock((url) => {
      if (url.includes("archive.org/wayback/available"))
        return {
          body: JSON.stringify({ archived_snapshots: { closest: { available: true, url: "https://web.archive.org/snap", timestamp: "20200102" } } }),
          contentType: "application/json",
        };
      if (url.includes("web.archive.org/snap")) return { body };
      return undefined;
    });
    const r = await rescueViaWayback("https://gone.test/x");
    expect(r?.text).toContain("recovered archival prose");
    expect(r?.snapshotUrl).toBe("https://web.archive.org/snap");
    expect(r?.timestamp).toBe("20200102");
  });
});
