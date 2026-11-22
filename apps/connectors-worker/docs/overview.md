# connectors-worker

agentdesk's connectors: the org's remote MCP servers — added by URL with no auth or a bearer token (kept in the vault), their tools discovered over Streamable HTTP and cached with a hash of each description, synced on demand — and the execution of a bot's granted MCP tools for agent-runtime through one McpSession Durable Object per org:server. Internal only (workers_dev off).

Part of the agentdesk runtime (specs/epics/agentdesk-agent-bots).

## Depends on

- cloudflare-d1 (connectors_servers, connectors_grants, vault_*)
- membership-worker, policy-worker (connector.manage)
- VAULT_KEK_V1 (runtime secret)

## Depended on by

- api-edge (/v1/organizations/{org}/connectors)
- agent-runtime-worker (POST /internal/call)
