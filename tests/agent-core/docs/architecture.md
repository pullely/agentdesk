# agent-core-tests — architecture

Jest (ts-jest ESM). `helpers.ts` loads `packages/agent-core/policies/policy.wasm` from disk and evaluates it with @open-policy-agent/opa-wasm, so the loop tests run the real policy; `.wasm` imports map to a stub.
