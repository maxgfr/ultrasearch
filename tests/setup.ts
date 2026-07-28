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
