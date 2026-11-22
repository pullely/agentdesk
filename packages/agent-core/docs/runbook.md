# agent-core — runbook

- **A tool is refused that should run:** check the bot's grants (`connectors_grants`), the tool name the model sees (`mcp__<server>__<tool>`), and the argument constraints; `opa eval -d policies/decision.rego 'data.agent.call.decision' -i input.json` reproduces the decision.
- **After editing decision.rego:** `pnpm --filter @saas/agent-core policy:test && pnpm --filter @saas/agent-core policy:build`, commit `policies/policy.wasm`.
- **A model call fails:** `/health` of agent-runtime names the model; BYOK keys are re-verified from the console (Agents → Model keys).
