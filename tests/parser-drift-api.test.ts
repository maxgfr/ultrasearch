import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { arxivBackend } from "../src/backends/arxiv.js";
import { crossrefBackend } from "../src/backends/crossref.js";
import { openalexBackend } from "../src/backends/openalex.js";
import { stackexchangeBackend } from "../src/backends/stackexchange.js";
import { githubBackend } from "../src/backends/github.js";
import { wikipediaBackend } from "../src/backends/wikipedia.js";
import { dblpBackend } from "../src/backends/dblp.js";
import type { Backend, RawSource } from "../src/types.js";
import { installFetchMock, routes } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

// API canary tests: each scholarly/community backend is replayed against a SAVED
// REAL response captured from its live API. When a provider changes its JSON/XML
// schema and a parser stops matching, these go red — the fast, deterministic
// signal the (weekly, report-only) network eval can't give. Refresh the fixture
// + parser together when a provider genuinely changes shape. Companion to
// tests/parser-drift.test.ts (which covers the HTML web-search backends).
const here = dirname(fileURLToPath(import.meta.url));
const apiFixture = (name: string) => readFileSync(join(here, "fixtures", "api", name), "utf8");

afterEach(() => vi.unstubAllGlobals());

function assertScholarly(items: RawSource[], min: number) {
  expect(items.length).toBeGreaterThanOrEqual(min);
  for (const it of items) {
    expect(it.url).toMatch(/^https?:\/\//);
    expect(it.title.length).toBeGreaterThan(0);
  }
}

interface Canary {
  name: string;
  backend: Backend;
  fixtures: [string, string][]; // [url-substring, fixture-file] (json unless .xml)
  min: number;
}

const CANARIES: Canary[] = [
  { name: "arxiv", backend: arxivBackend, fixtures: [["export.arxiv.org", "arxiv.xml"]], min: 2 },
  { name: "crossref", backend: crossrefBackend, fixtures: [["api.crossref.org", "crossref.json"]], min: 2 },
  { name: "openalex", backend: openalexBackend, fixtures: [["api.openalex.org", "openalex.json"]], min: 2 },
  { name: "stackexchange", backend: stackexchangeBackend, fixtures: [["api.stackexchange.com", "stackexchange.json"]], min: 2 },
  { name: "github", backend: githubBackend, fixtures: [["api.github.com", "github.json"]], min: 2 },
  {
    name: "wikipedia",
    backend: wikipediaBackend,
    fixtures: [
      ["/search/page", "wikipedia-search.json"],
      ["/summary/", "wikipedia-summary.json"],
    ],
    min: 1,
  },
  { name: "dblp", backend: dblpBackend, fixtures: [["dblp.org/search/publ", "dblp.json"]], min: 2 },
];

describe("API parser drift canaries (saved real responses)", () => {
  for (const c of CANARIES) {
    it(`${c.name} still parses its real-API response`, async () => {
      const pairs: [string, { body: string; contentType: string }][] = c.fixtures.map(([frag, file]) => [
        frag,
        { body: apiFixture(file), contentType: file.endsWith(".xml") ? "application/atom+xml" : "application/json" },
      ]);
      installFetchMock(routes(pairs));
      const r = await c.backend(makeCtx("rate limiting"));
      assertScholarly(r.items, c.min);
    });
  }
});
