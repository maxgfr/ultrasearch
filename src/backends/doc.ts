// Office-document text extraction — public surface.
//
// The implementation now lives in the vendored webindex engine
// (github.com/maxgfr/webindex), pinned in src/vendor/webindex.meta.json. It used
// to live in ./doc/, in a copy byte-identical to construct's and ultradoc's
// apart from the environment-variable prefix.

export {
  docFormatForUrl,
  DOC_EXTENSIONS,
  extractDocument,
  enabledDocExtractors,
  resetDocLadderCache,
} from "../engine.js";
