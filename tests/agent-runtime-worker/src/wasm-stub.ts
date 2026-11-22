// Under Node, `import policyWasm from "../../policies/policy.wasm"` resolves
// here: the same compiled policy wrangler bundles, as a WebAssembly.Module.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WasmModule = WebAssembly.Module as unknown as new (bytes: Uint8Array) => WebAssembly.Module;
const policyWasm = new WasmModule(readFileSync(join(here, "../../../packages/agent-core/policies/policy.wasm")));
export default policyWasm;
