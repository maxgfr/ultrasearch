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
      reporter: ["text-summary", "text"],
      // A ratchet, not an aspiration: set a couple of points below the measured
      // baseline (statements ~95%, branches ~86%, functions ~97%, lines ~97% as
      // of the audit-hardening + edge-coverage pass) so coverage can't silently
      // regress. Raise these when real coverage climbs; never lower them to make
      // a red run pass.
      thresholds: {
        statements: 93,
        branches: 83,
        functions: 96,
        lines: 95,
      },
    },
  },
});
