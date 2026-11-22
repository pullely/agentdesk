# agent-runtime-worker

agentdesk's agent runtime: one ThreadAgent Durable Object (SQLite) per org:project:team:channel:thread_ts runs the ported ai-slackbot agent loop for that Slack thread — memory, compaction, FIFO turns, the pinned config version, streamed replies — and the playground on a bot's draft config. Internal only (workers_dev off).

Part of the agentdesk runtime (specs/epics/agentdesk-agent-bots).

## Depends on

- cloudflare-d1 (PLATFORM_DB: bots_*, connectors_*, vault_*, agent_runs, metering, events)
- Workers AI (AI) through AI Gateway agentdesk-<env>
- connectors-worker (CONNECTORS_WORKER: MCP calls, AD-6)
- VAULT_KEK_V1 (runtime secret); the AI Gateway URL comes from the AI binding

## Depended on by

- slack-gateway-worker (POST /internal/turn)
- bots-worker (POST /internal/playground)
