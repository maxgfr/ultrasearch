// Side-effect module: make the fetch backoff instant so failure-path tests
// (429/503 retry, network-error retry) don't wait real milliseconds. Must be
// imported FIRST, before src/backends/fetch.ts reads these env vars at module
// load — same ordering contract as _polite0.ts.
process.env.ULTRASEARCH_POLITE_DELAY_MS = "0";
process.env.ULTRASEARCH_RETRY_MS = "0";
