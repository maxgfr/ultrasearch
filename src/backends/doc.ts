// Office-document text extraction — public surface.
//
// The implementation now lives in the vendored webindex engine
// (github.com/maxgfr/webindex), pinned in src/vendor/engine.meta.json. It used
// to live in ./doc/, in a copy byte-identical to construct's and ultradoc's
// apart from the environment-variable prefix.

export {
  docFormatForUrl,
  docFormatForContentType,
  DOC_EXTENSIONS,
  extractDocument,
  enabledDocExtractors,
  resetDocLadderCache,
  DOC_EXTRACTORS,
  type DocFormat,
  type DocExtraction,
  type DocExtractorId,
  type DocLadderOptions,
} from "../engine.js";
