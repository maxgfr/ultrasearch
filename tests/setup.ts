// The on-disk fetch cache is ON by default (see buildGatherOptions), so a test
// that drives the CLI could otherwise write into the real
// $TMPDIR/ultrasearch/cache and — on a second run inside the 24h TTL — be served
// a page from disk instead of the mocked network. That would make the suite
// depend on machine state, breaking the "tests stay offline and deterministic"
// golden rule. Give every test run its own throwaway cache dir instead.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "us-test-cache-"));
process.env.ULTRASEARCH_CACHE_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

// Firecrawl defaults to http://localhost:3002 and is gated by an availability
// probe. Under a stubbed global fetch that probe would SUCCEED (the mock answers
// every URL), so every test would silently route its extraction through a fake
// Firecrawl. Disable it globally; the tests that exercise Firecrawl pass an
// explicit base (`{ firecrawl: "http://fc.test" }`), which overrides this.
process.env.ULTRASEARCH_FIRECRAWL = "off";

// SearXNG now defaults to http://localhost:8888 behind the same kind of probe,
// so it needs the same treatment for the same reason: a stubbed fetch would make
// the probe succeed and every discovery test would route through a fake SearXNG.
// The tests that exercise it pass an explicit base (`{ searxng: "http://sx.test" }`).
process.env.ULTRASEARCH_SEARXNG = "off";

// The PDF extractor ladder shells out to npx (pdf-inspector) and pdftotext. In a
// test that would mean network access, ~90s timeouts, and results that depend on
// which tools the developer happens to have installed — the opposite of an
// offline, deterministic suite. Pin it to the built-in reader; the tests that
// exercise other rungs set ULTRASEARCH_PDF_ENGINE or pass `engines` themselves.
process.env.ULTRASEARCH_PDF_ENGINE = "native";

// The office-document ladder shells out to npx (anydoc) too, and unlike the PDF
// one it has no built-in last rung to pin it to — so `none` disables it. The
// tests that exercise a rung pass `engines` themselves. This also keeps the
// default assertion honest: an office document nothing can read must REFUSE,
// which is the regression tests/doc-extract.ts pins.
process.env.ULTRASEARCH_DOC_ENGINE = "none";
