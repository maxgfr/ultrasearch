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
