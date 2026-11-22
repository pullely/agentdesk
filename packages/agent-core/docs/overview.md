# agent-core

The agent loop agentdesk's runtime and playground share: the ported ai-slackbot loop, the OPA policy WASM, the model router, built-in tools, Slack signatures and the SSRF guard

Part of agentdesk's AI agent bots (specs/epics/agentdesk-agent-bots). A workspace package built by the turbo pipeline; it deploys nothing on its own.

## Depends on

- (none in the workspace; AI SDK, policy-opa, workers-ai-provider)

## Depended on by

- agent-runtime-worker, bots-worker, connectors-worker, slack-gateway-worker, config-worker (verify only)
