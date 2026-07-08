import { afterEach, describe, expect, it, vi } from "vitest";
import { standardsBackend } from "../src/backends/standards.js";
import { installFetchMock } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

afterEach(() => vi.unstubAllGlobals());

const RFC6585 = JSON.stringify({
  objects: [{ name: "rfc6585", rfc_number: 6585, title: "Additional HTTP Status Codes", abstract: "This document specifies additional HTTP status codes." }],
});
const MDN_429 = JSON.stringify({
  documents: [
    { mdn_url: "/en-US/docs/Web/HTTP/Status/429", title: "429 Too Many Requests", summary: "The HTTP 429 Too Many Requests response status code." },
    { mdn_url: "/en-US/docs/Web/HTTP/Status", title: "HTTP response status codes", summary: "HTTP status codes." },
  ],
});
// A title search where one hit is a real RFC and one is off-topic (RFC 2429
// merely shares the digits) and a slide deck with no rfc_number.
const TITLE_SEARCH = JSON.stringify({
  objects: [
    { name: "rfc6585", rfc_number: 6585, title: "Additional HTTP Status Codes for rate limiting", abstract: "…" },
    { name: "rfc2429", rfc_number: 2429, title: "RTP Payload Format for the 1998 Version of ITU-T", abstract: "video codec" },
    { name: "slides-1", rfc_number: null, title: "Rate limiting slides", abstract: "a deck" },
  ],
});

describe("standardsBackend", () => {
  it("resolves an explicit RFC number via the datatracker name lookup", async () => {
    installFetchMock((url) => {
      if (url.includes("name=rfc6585")) return { body: RFC6585, contentType: "application/json" };
      if (url.includes("developer.mozilla.org")) return { body: JSON.stringify({ documents: [] }), contentType: "application/json" };
      if (url.includes("datatracker")) return { body: JSON.stringify({ objects: [] }), contentType: "application/json" };
      return undefined;
    });
    const r = await standardsBackend(makeCtx("what does RFC 6585 define about status 429"));
    const rfc = r.items.find((i) => i.url.includes("rfc6585"));
    expect(rfc).toBeTruthy();
    expect(rfc!.url).toBe("https://www.rfc-editor.org/rfc/rfc6585");
    expect(rfc!.text).toContain("additional HTTP status codes");
    expect(rfc!.meta?.rfcNumber).toBe(6585);
  });

  it("returns MDN documents as discovery hits (url + snippet, no text)", async () => {
    installFetchMock((url) => {
      if (url.includes("developer.mozilla.org")) return { body: MDN_429, contentType: "application/json" };
      if (url.includes("datatracker")) return { body: JSON.stringify({ objects: [] }), contentType: "application/json" };
      return undefined;
    });
    const r = await standardsBackend(makeCtx("http 429 too many requests"));
    const mdn = r.items.find((i) => i.url.includes("developer.mozilla.org"));
    expect(mdn!.url).toBe("https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429");
    expect(mdn!.snippet).toContain("429 Too Many Requests");
    expect(mdn!.text).toBeUndefined(); // discovery — gather hydrates the page
  });

  it("keeps only RFC-numbered title hits and filters the digit-only false friend", async () => {
    installFetchMock((url) => {
      if (url.includes("title__icontains")) return { body: TITLE_SEARCH, contentType: "application/json" };
      if (url.includes("developer.mozilla.org")) return { body: JSON.stringify({ documents: [] }), contentType: "application/json" };
      if (url.includes("name=rfc")) return { body: JSON.stringify({ objects: [] }), contentType: "application/json" };
      return undefined;
    });
    const r = await standardsBackend(makeCtx("rate limiting"));
    const rfcNums = r.items.filter((i) => i.meta?.rfcNumber).map((i) => i.meta!.rfcNumber);
    expect(rfcNums).toContain(6585); // real match on "rate limiting"
    expect(rfcNums).not.toContain(2429); // shares no query term, only digits — dropped
    expect(r.items.some((i) => i.title?.includes("slides"))).toBe(false); // no rfc_number → dropped
  });

  it("degrades to a note when both APIs are down", async () => {
    installFetchMock(() => ({ status: 500, body: "" }));
    const r = await standardsBackend(makeCtx("some standard"));
    expect(r.items).toHaveLength(0);
    expect(r.backend).toBe("standards");
    expect(r.notes.length).toBeGreaterThan(0);
  });
});
