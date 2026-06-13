import { vi } from "vitest";

export interface MockResponse {
  status?: number;
  body: string;
  contentType?: string;
  headers?: Record<string, string>; // extra response headers (e.g. retry-after)
  url?: string; // final URL after redirects (defaults to the requested URL)
}

export type Router = (url: string, init?: RequestInit) => MockResponse | undefined;

// Stub globalThis.fetch with a router keyed by URL substring match. Backends go
// through src/backends/fetch.ts which only uses res.ok / status / url /
// arrayBuffer / text / headers.get — so a tiny fake Response is enough. The
// router may be stateful (close over a counter) to simulate 429-then-200.
// Returns the spy.
export function installFetchMock(router: Router) {
  const spy = vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const r = router(url, init);
    if (!r) {
      return makeResponse({ status: 404, body: "not found", contentType: "text/plain" }, url);
    }
    return makeResponse(r, url);
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function makeResponse(r: MockResponse, requestedUrl: string) {
  const status = r.status ?? 200;
  const body = r.body;
  const contentType = r.contentType ?? "text/html";
  const headers = r.headers ?? {};
  return {
    ok: status >= 200 && status < 300,
    status,
    url: r.url ?? requestedUrl,
    headers: {
      get: (k: string) => {
        const key = k.toLowerCase();
        if (key in headers) return headers[key]!;
        if (key === "content-type") return contentType;
        return null;
      },
    },
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
