# agent-runtime-worker-tests — architecture

- `fake-ai.ts`: run `<cmd>` → bash tool call; after a tool result → 'Tool said'; else 'Echo'.
- `fake-do.ts`: DurableObjectState with storage.sql over node:sqlite.
- `cf-workers-stub.ts`: the DurableObject base class.
- `wasm-stub.ts`: the compiled policy as a WebAssembly.Module.
