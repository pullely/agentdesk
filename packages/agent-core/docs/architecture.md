# agent-core — architecture

- `src/agent.ts` — `runAgent`: AI SDK `streamText` with `stopWhen: stepCountIs(maxSteps)`; every tool call goes through `toolApproval`, which evaluates `policies/policy.wasm` (`agent/call/decision`) with the bot's grants in `runtimeContext.grants`. `requires-approval` goes to an approval handler (AD1 refuses).
- `src/model.ts` — `resolveModel(modelRef, key, gateway)`: Workers AI (default `@cf/moonshotai/kimi-k2.6`) or BYOK OpenAI / Anthropic / OpenAI-compatible, through the environment's AI Gateway with `cf-aig-metadata`.
- `src/verify.ts` — the key check on save, free of the AI SDK.
- `policies/decision.rego` — grants first (no grant → deny), argument constraints as globs, then upstream's bash and file safety rules. Rebuild with `pnpm --filter @saas/agent-core policy:build`; test with `policy:test`.
- Ported from sourceplane/ai-slackbot baseline-v3 (MIT, vercel-labs/ai-sdk-slackbot); see NOTICE.
