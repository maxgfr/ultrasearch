// The no-write gate — public surface.
//
// The implementation now lives in the vendored webindex engine
// (github.com/maxgfr/webindex). Every write in src/ still passes through
// writeArtifact, so read-only operation stays a property of one module rather
// than a promise each command keeps individually.

export { setNoWrite, isNoWrite, ensureDir, writeArtifact, takeArtifacts, resetNoWrite, type Artifact } from "./engine.js";
