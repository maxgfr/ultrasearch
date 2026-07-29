// Serialize work that touches one dossier directory.
//
// `addSource` is not concurrency-safe: it reads sources.json, checks whether
// the URL is already there, assigns the next free [S#] and writes the file
// back. Two overlapping fetches into the same dossier both read the same
// highest id, both claim it, and one source silently overwrites the other —
// which is worse than losing it, because the citation still resolves, just to
// the wrong page. `render` and `verify` read that same file while it is being
// rewritten.
//
// The CLI never hit this because one process runs one command to completion.
// The MCP server can have several tool calls in flight at once, and ingesting
// a handful of URLs concurrently is the obvious thing for a client to do.
//
// The fix is a promise chain per dossier — the smallest thing that is actually
// correct. It is deliberately coarse: a `read` blocks a `fetch` on the SAME
// dossier, while different dossiers stay fully parallel. Note what is NOT
// locked: `gather` creates its own directory, so there is nothing to contend
// for until it returns.
//
// This guards a single process. An MCP server and a CLI invocation writing the
// same dossier side by side remains a known gap.
const chains = new Map<string, Promise<unknown>>();

export function withRunLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(slug) ?? Promise.resolve();
  // Chain off `prev` however it settled: a failed predecessor must not poison
  // every later call for the same repo.
  const next = prev.then(fn, fn);
  // The tail the NEXT caller waits on never rejects, so one thrown tool call
  // can't reject the whole queue behind it.
  const tail = next.then(noop, noop);
  chains.set(slug, tail);
  // Drop the entry once the tail is still us, so a long-lived server doesn't
  // accumulate a settled promise per repo it ever touched.
  tail.then(() => {
    if (chains.get(slug) === tail) chains.delete(slug);
  }, noop);
  return next;
}

function noop(): void {}

// Test seam: drop every pending chain. Never call this from product code — an
// in-flight lock holder would stop serializing against later arrivals.
export function resetRunLocks(): void {
  chains.clear();
}
