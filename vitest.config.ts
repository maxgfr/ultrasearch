import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests write dossiers into /tmp/ultrasearch and read static fixtures —
    // never collect tests from those trees.
    exclude: [...configDefaults.exclude, "**/.ultrasearch/**", "tests/fixtures/**"],
    // Pins ULTRASEARCH_CACHE_DIR to a throwaway dir — the fetch cache is on by
    // default, and the suite must never read or write the real one.
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // The vendored webindex bundle is not this repo's code — it is a pinned
      // artifact with its own suite and its own ratchet in its own repository,
      // and its bytes are verified against a sha256 rather than edited here.
      // Counting it would measure how much of SOMEONE ELSE's engine this
      // skill's tests happen to reach, which is not a number worth defending.
      exclude: ["src/vendor/**"],
      reporter: ["text-summary", "text"],
      // A ratchet, not an aspiration: set a couple of points below the measured
      // baseline (statements ~95%, branches ~86%, functions ~97%, lines ~97% as
      // of the audit-hardening + edge-coverage pass) so coverage can't silently
      // regress. Raise these when real coverage climbs; never lower them to make
      // a red run pass.
      thresholds: {
        statements: 93,
        branches: 83,
        // 96 -> 95 when the retrieval layer moved to the vendored webindex
        // engine. Arithmetic, not regression: the PDF and office ladders were
        // among the best-covered files here, so removing them from the
        // population lowers the average of what remains. No test of
        // ultrasearch's OWN code was dropped — the six suites that went with
        // the move now run in webindex, against the same code.
        functions: 95,
        lines: 95,
      },
    },
  },
});
