// HTTP and extraction — public surface.
//
// The implementation now lives in the vendored webindex engine
// (github.com/maxgfr/webindex), pinned in src/vendor/webindex.meta.json. This
// file stays as the import path the backends already use.
//
// Note the four accessors at the bottom. They were module-load constants here
// (BROWSER_UA, CONTACT_UA, PAGE_DELAY_MS, POLITE_DELAY_MS), which is safe only
// while the env prefix is a compile-time literal. In a shared engine it is not:
// the bundle is imported before configure() can run, so a constant would freeze
// webindex's own default prefix and silently ignore every ULTRASEARCH_* value a
// user sets. Callers now call them.

export {
  httpGet,
  httpJson,
  sleep,
  decodeEntities,
  cleanInline,
  htmlToText,
  htmlTitle,
  htmlCanonicalUrl,
  extractMainHtml,
  looksLikePdfUrl,
  fetchAndExtract,
  rescueViaWayback,
  looksLikeJunkExtraction,
  nearestHeading,
  focusedSnippet,
  bestExcerpt,
  capExtract,
  DEAD_LINK_STATUS,
  browserUa,
  contactUa,
  pageDelayMs,
  politeDelayMs,
  type HttpResult,
  type ExtractResult,
  type ExtractorId,
} from "../engine.js";
