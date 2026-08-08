// Citability — is a URL something a READER can open?
//
// The engine owns it: the endpoint test is shape-based and the derivation reads
// identifiers out of whatever came back, so nothing here was ever
// ultrasearch-specific. This module stays as the import path the repo already
// uses — 11 files import these four modules, and none of them has to change.

export { addressedIdCount, deriveCitableUrl, isApiEndpoint, isCitableUrl, urlDeclaresIdentity } from "./engine.js";
