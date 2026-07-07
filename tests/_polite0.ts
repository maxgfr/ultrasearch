// Side-effect module: disable the polite scholarly-API inter-variant delay so
// serialization tests don't wait real milliseconds. Imported FIRST by
// registry.test.ts, before src/backends/fetch.ts reads the env at module load.
process.env.ULTRASEARCH_POLITE_DELAY_MS = "0";
