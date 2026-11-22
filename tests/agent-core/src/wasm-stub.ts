// Jest stand-in for `import policyWasm from "../../policies/policy.wasm"`:
// wrangler compiles that import into a WebAssembly.Module; under Node the
// tests read the same compiled file themselves (helpers.ts).
const stub: unknown = undefined;
export default stub;
