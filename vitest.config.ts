import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests write dossiers into /tmp/ultrasearch and read static fixtures —
    // never collect tests from those trees.
    exclude: [...configDefaults.exclude, "**/.ultrasearch/**", "tests/fixtures/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "text"],
      // A ratchet, not an aspiration: set a couple of points below the measured
      // baseline (statements ~87%, branches ~73%, functions ~95%, lines ~89% as
      // of the P2 hardening pass) so coverage can't silently regress. Raise these
      // when real coverage climbs; never lower them to make a red run pass.
      thresholds: {
        statements: 85,
        branches: 71,
        functions: 92,
        lines: 87,
      },
    },
  },
});
