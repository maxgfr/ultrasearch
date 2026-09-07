import { homedir } from "node:os";
import { join } from "node:path";
import { brand, ensureComposeMaterialized as engineCompose, stackControl as engineStackControl, type StackDeps } from "./vendor/webindex-engine.mjs";

// All tools share one Compose project. Its relative bind mounts must therefore
// resolve from one directory, independently of each tool's HTTP/clone cache.
// The pinned engine exposes only CACHE_DIR for materialization; scope that
// override to its synchronous lifecycle call and restore it on every exit.
function withStackCache<T>(action: () => T): T {
  const key = brand().envPrefix + "_CACHE_DIR";
  const saved = process.env[key];
  process.env[key] = process.env.ULTRA_STACK_CACHE_DIR || join(homedir(), ".cache", "skills");
  try {
    return action();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

export function materializeSharedStack(): string {
  return withStackCache(engineCompose);
}

export function sharedStackControl(service: string | string[], action: string, deps: StackDeps = {}): ReturnType<typeof engineStackControl> {
  return withStackCache(() => engineStackControl(service, action, deps));
}
