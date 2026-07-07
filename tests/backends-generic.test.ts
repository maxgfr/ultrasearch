import { afterEach, describe, expect, it, vi } from "vitest";
import { genericBackend } from "../src/backends/generic.js";
import { installFetchMock } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

afterEach(() => vi.unstubAllGlobals());

const page = (body: string) => `<html><head><title>Doc</title></head><body><main>${body}</main></body></html>`;
const LONG = "Rate limiting is a technique for controlling request throughput. ".repeat(20);

// generic.ts fetches an explicit --url set into full-text sources. Covers the
// no-url guard, a fetch that fails (note, no item), and rank-ordered scoring.
describe("genericBackend", () => {
  it("notes when no --url was supplied", async () => {
    const r = await genericBackend(makeCtx("q"));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/needs --url/i);
  });

  it("fetches each url, records a note for a failed one, and skips it", async () => {
    installFetchMock((url) => {
      if (url.includes("good.test")) return { body: page(LONG), contentType: "text/html" };
      if (url.includes("bad.test")) return { status: 403, body: "" };
      return undefined;
    });
    const r = await genericBackend(makeCtx("rate limiting", { urls: ["https://good.test/a", "https://bad.test/b"] }));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.url).toBe("https://good.test/a");
    expect(r.items[0]!.text).toMatch(/rate limiting/i);
    expect(r.notes.join(" ")).toMatch(/could not fetch .*bad\.test/i);
  });

  it("scores urls by their position in the list (first is highest)", async () => {
    installFetchMock((url) => ({ body: page(LONG + url), contentType: "text/html" }));
    const r = await genericBackend(makeCtx("q", { urls: ["https://a.test/1", "https://b.test/2", "https://c.test/3"] }));
    expect(r.items).toHaveLength(3);
    expect(r.items[0]!.score).toBe(3); // urls.length - 0
    expect(r.items[2]!.score).toBe(1); // urls.length - 2
  });
});
