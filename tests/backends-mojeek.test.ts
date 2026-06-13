import { afterEach, describe, expect, it, vi } from "vitest";
import { mojeekBackend } from "../src/backends/mojeek.js";
import { installFetchMock, routes } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

afterEach(() => vi.unstubAllGlobals());

// Mojeek results: each <li> has a class="title" anchor (direct URL, no
// redirector) and a <p class="s"> snippet. Includes an own-domain result to drop
// and a preceding non-title anchor that must be ignored.
const MOJEEK_HTML = `
<ul class="results-standard">
  <li><a class="ob" href="https://real.test/m1"></a>
      <a class="title" href="https://real.test/m1">Mojeek One &amp; Only</a>
      <p class="s">snippet one about leaky bucket</p></li>
  <li><a class="title" href="https://www.mojeek.com/about">About Mojeek</a>
      <p class="s">own domain snippet</p></li>
  <li><a class="title" href="https://real.test/m2">Mojeek Two</a>
      <p class="s">snippet two</p></li>
</ul>`;

describe("mojeekBackend", () => {
  it("extracts direct title URLs + snippets, drops its own domain, no index shift", async () => {
    installFetchMock(routes([["mojeek.com/search", { body: MOJEEK_HTML }]]));
    const r = await mojeekBackend(makeCtx("leaky bucket"));
    expect(r.items.map((i) => i.url)).toEqual(["https://real.test/m1", "https://real.test/m2"]);
    expect(r.items[0]!.title).toBe("Mojeek One & Only");
    expect(r.items[0]!.snippet).toContain("leaky bucket");
    expect(r.items[1]!.snippet).toBe("snippet two");
  });

  it("notes when unreachable", async () => {
    installFetchMock(() => ({ status: 0, body: "" }));
    const r = await mojeekBackend(makeCtx("x"));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/unreachable/i);
  });
});
