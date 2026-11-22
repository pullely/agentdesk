# worker-kit

Request plumbing shared by agentdesk's new Workers: envelopes, actor headers, public ids, and one fail-closed membership + policy authorize()

Part of agentdesk's AI agent bots (specs/epics/agentdesk-agent-bots). A workspace package built by the turbo pipeline; it deploys nothing on its own.

## Depends on

- contracts, db

## Depended on by

- bots-worker, connectors-worker, slack-gateway-worker, agent-runtime-worker, config-worker
