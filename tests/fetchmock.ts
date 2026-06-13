import { vi } from "vitest";

export interface MockResponse {
  status?: number;
  body: string;
  contentType?: string;
}

export type Router = (url: string, init?: RequestInit) => MockResponse | undefined;

// Stub globalThis.fetch with a router keyed by URL substring match. Backends go
// through src/backends/fetch.ts which only uses res.ok / status / arrayBuffer /
// text / headers.get — so a tiny fake Response is enough. Returns the spy.
export function installFetchMock(router: Router) {
  const spy = vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const r = router(url, init);
    if (!r) {
      return makeResponse({ status: 404, body: "not found", contentType: "text/plain" });
    }
    return makeResponse(r);
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function makeResponse(r: MockResponse) {
  const status = r.status ?? 200;
  const body = r.body;
  const contentType = r.contentType ?? "text/html";
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? contentType : null) },
    async arrayBuffer() {
      return new TextEncoder().encode(body).buffer;
    },
    async text() {
      return body;
    },
  } as unknown as Response;
}

// Build a map-style router from [substring, response] pairs (first match wins).
export function routes(pairs: [string, MockResponse][]): Router {
  return (url) => pairs.find(([frag]) => url.includes(frag))?.[1];
}
