import { vi } from "vitest";

export interface MockResponse {
  status?: number;
  /** The response body as text. Optional only when `bytes` supplies it instead. */
  body?: string;
  contentType?: string;
  headers?: Record<string, string>; // extra response headers (e.g. retry-after)
  url?: string; // final URL after redirects (defaults to the requested URL)
  // Raw response bytes, for a body that is NOT valid UTF-8 (a .docx is a ZIP, a
  // .doc an OLE stream). Set this and `body` is ignored: `arrayBuffer()` hands
  // back these bytes and `text()` decodes them the way httpGet does, so a test
  // sees exactly the mojibake a real binary download produces.
  bytes?: Buffer;
  // Hold the response open for this many ms before resolving. For the tests that
  // care about what happens WHILE a fetch is in flight (two workers reaching for
  // the same URL at once), which a synchronous router cannot otherwise express.
  delayMs?: number;
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
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    return makeResponse(r, url);
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function makeResponse(r: MockResponse, requestedUrl: string) {
  const status = r.status ?? 200;
  const body = r.body ?? "";
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
      if (r.bytes) return r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength);
      return new TextEncoder().encode(body).buffer;
    },
    async text() {
      return r.bytes ? r.bytes.toString("utf8") : body;
    },
  } as unknown as Response;
}

// Build a map-style router from [substring, response] pairs (first match wins).
export function routes(pairs: [string, MockResponse][]): Router {
  return (url) => pairs.find(([frag]) => url.includes(frag))?.[1];
}
