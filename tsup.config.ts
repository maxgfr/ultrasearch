import { defineConfig } from "tsup";

// Bundles the TypeScript engine into a single, dependency-free ESM script
// (scripts/ultrasearch.mjs) that any agent sandbox can run with `node` — no
// `npm install` required at skill-use time. The committed bundle is verified
// reproducible in CI via `pnpm run check:build`.
export default defineConfig({
  entry: { ultrasearch: "src/cli.ts" },
  outDir: "scripts",
  format: ["esm"],
  outExtension: () => ({ js: ".mjs" }),
  target: "node18",
  platform: "node",
  bundle: true,
  clean: false,
  minify: false,
  splitting: false,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
});
