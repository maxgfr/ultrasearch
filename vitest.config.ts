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
      // baseline (statements ~94%, branches ~83%, functions ~96%, lines ~96% as
      // of the parser-hardening + CLI/pipeline test pass) so coverage can't
      // silently regress. Raise these when real coverage climbs; never lower them
      // to make a red run pass.
      thresholds: {
        statements: 92,
        branches: 81,
        functions: 95,
        lines: 94,
      },
    },
  },
});
