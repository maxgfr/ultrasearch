import { afterEach, describe, expect, it, vi } from "vitest";
import { stackexchangeBackend } from "../src/backends/stackexchange.js";
import { installFetchMock } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

afterEach(() => vi.unstubAllGlobals());

const siteOf = (url: string) => /site=([^&]+)/.exec(url)?.[1] ?? "";

// Edge-case coverage for stackexchange.ts: a site that errors, a result missing
// its link, a result with no score / not-answered, and the backoff/quota notes.
describe("stackexchangeBackend — edge cases", () => {
  it("tolerates one site returning a non-ok / malformed response", async () => {
    const ok = JSON.stringify({
      items: [{ title: "Q", link: "https://stackoverflow.com/q/1", score: 3, is_answered: true, question_id: 1, body: "<p>b</p>" }],
    });
    installFetchMock((url) => {
      if (!url.includes("api.stackexchange.com")) return undefined;
      if (siteOf(url) === "serverfault") return { status: 500, body: "boom" };
      return { body: ok, contentType: "application/json" };
    });
    const r = await stackexchangeBackend(makeCtx("some error"));
    expect(r.items).toHaveLength(4); // 5 sites, serverfault dropped, no crash
    expect(r.notes.join(" ")).toMatch(/returned 4 question/i);
  });

  it("synthesizes a fallback question url when the API omits the link", async () => {
    const body = JSON.stringify({ items: [{ title: "No link", question_id: 77, score: 1, is_answered: false, body: "<p>x</p>" }] });
    installFetchMock((url) => (url.includes("api.stackexchange.com") ? { body, contentType: "application/json" } : undefined));
    const r = await stackexchangeBackend(makeCtx("q"));
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((it) => /\/q\/77$/.test(it.url))).toBe(true);
  });

  it("scores a result with no score and not-answered from rank alone", async () => {
    const body = JSON.stringify({ items: [{ title: "Bare", link: "https://stackoverflow.com/q/9", question_id: 9, body: "<p>x</p>" }] });
    installFetchMock((url) => (url.includes("api.stackexchange.com") ? { body, contentType: "application/json" } : undefined));
    const r = await stackexchangeBackend(makeCtx("q"));
    // score = (score??0) + (is_answered?2:0) + (perSite - i)*0.1  →  0 + 0 + rank*0.1
    expect(r.items[0]!.score).toBeGreaterThan(0);
    expect(r.items[0]!.score).toBeLessThan(1);
    expect(r.items[0]!.meta?.answerScore).toBe(0);
  });

  it("surfaces a backoff and a low-quota note", async () => {
    const throttled = JSON.stringify({
      items: [{ title: "Q", link: "https://stackoverflow.com/q/1", score: 1, is_answered: true, question_id: 1, body: "<p>b</p>" }],
      backoff: 12,
      quota_remaining: 5,
    });
    const normal = JSON.stringify({ items: [] });
    installFetchMock((url) => {
      if (!url.includes("api.stackexchange.com")) return undefined;
      return siteOf(url) === "stackoverflow" ? { body: throttled, contentType: "application/json" } : { body: normal, contentType: "application/json" };
    });
    const r = await stackexchangeBackend(makeCtx("q"));
    const notes = r.notes.join(" ");
    expect(notes).toMatch(/back off 12s/i);
    expect(notes).toMatch(/quota low \(5 left\)/i);
  });
});
