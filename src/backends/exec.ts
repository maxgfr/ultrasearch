// Running an external converter on stdin — the subprocess seam.
//
// A narrow module on purpose. `services.ts` probes the npx rungs through it,
// and tests/services-doc.test.ts replaces THIS module to keep the suite offline
// and deterministic. Pointing that mock at the whole PDF facade instead would
// also blank out extractPdf for every other consumer of it.

export { runWithInput, ANYDOC_SPEC, PDF_INSPECTOR_SPEC } from "../engine.js";
