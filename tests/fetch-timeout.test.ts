import { describe, it, expect, afterEach, vi } from "vitest";
import { httpGet, httpJson } from "../src/backends/fetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// Both HTTP entry points arm an AbortController before every attempt, so a host
// that accepts the connection and then says nothing costs a bounded wait rather
// than hanging the run. Nothing else in the suite exercises that path: every
// other test's mock answers immediately.
//
// The stub resolves only when the signal fires, which is the shape of a real
// blackholed host — and means these tests would hang, not fail, if the abort
// were ever dropped.
function installHangingFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
      });
    }),
  );
}

describe("request timeouts", () => {
  it("gives up on a host that never answers, and reports it instead of throwing", async () => {
    installHangingFetch();
    vi.stubEnv("ULTRASEARCH_MAX_ATTEMPTS", "1");
    const r = await httpGet("https://blackhole.test/x", { timeoutMs: 5 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toBeTruthy();
  });

  it("does the same for a JSON endpoint", async () => {
    installHangingFetch();
    vi.stubEnv("ULTRASEARCH_MAX_ATTEMPTS", "1");
    const r = await httpJson("POST", "https://blackhole.test/v2/scrape", { url: "https://x.test" }, { timeoutMs: 5 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toBeTruthy();
  });
});
