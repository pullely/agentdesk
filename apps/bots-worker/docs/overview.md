# bots-worker

agentdesk's bot bounded context: one bot per Cirrus project — its profile, its versioned config (one draft, one published, immutable once published), its tool grants, publish, the playground relay to agent-runtime-worker, and the runs it recorded.

Part of the agentdesk runtime (specs/epics/agentdesk-agent-bots). Reached only through api-edge's agents facade.

## Depends on

- cloudflare-d1 (PLATFORM_DB: bots_*, connectors_grants, agent_runs)
- membership-worker, policy-worker (authorization)
- agent-runtime-worker (AGENT_RUNTIME: the playground)

## Depended on by

- api-edge
