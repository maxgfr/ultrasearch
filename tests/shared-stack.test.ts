import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { brand, configure, ensureComposeMaterialized, stackControl } from "../src/engine.js";

describe("shared Docker stack location", () => {
  it("resolves the same bind source across brands with distinct page caches", () => {
    const root = mkdtempSync(join(tmpdir(), "shared-stack-"));
    const original = { ...brand() };
    try {
      vi.stubEnv("ULTRA_STACK_CACHE_DIR", join(root, "shared"));
      const mounts: string[] = [];
      for (const name of ["first", "second"]) {
        configure({ name, envPrefix: name.toUpperCase(), cli: name });
        vi.stubEnv(name.toUpperCase() + "_CACHE_DIR", join(root, name));
        const file = ensureComposeMaterialized();
        expect(readFileSync(file, "utf8")).toContain("./docker/searxng:/etc/searxng:rw");
        mounts.push(resolve(dirname(file), "docker/searxng"));
        expect(process.env[name.toUpperCase() + "_CACHE_DIR"]).toBe(join(root, name));
      }
      expect(mounts[0]).toBe(mounts[1]);
      expect(mounts[0]).toBe(join(root, "shared/compose/docker/searxng"));
    } finally {
      configure(original);
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores the per-tool cache even when the Docker runner throws", () => {
    const root = mkdtempSync(join(tmpdir(), "shared-stack-"));
    const key = brand().envPrefix + "_CACHE_DIR";
    try {
      vi.stubEnv(key, join(root, "pages"));
      vi.stubEnv("ULTRA_STACK_CACHE_DIR", join(root, "shared"));
      expect(() =>
        stackControl("searxng", "up", {
          has: () => true,
          run: (_cmd, args) => {
            expect(args).toContain(join(root, "shared/compose/docker-compose.yml"));
            throw new Error("runner failed");
          },
        }),
      ).toThrow("runner failed");
      expect(process.env[key]).toBe(join(root, "pages"));
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
