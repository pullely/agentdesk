# slack-gateway-worker

agentdesk's Slack gateway: the public ingress for Slack (its own workers.dev host, not behind api-edge) — the Events API, slash commands, interactivity and the shared app's OAuth install — plus the authenticated installation and channel-binding routes api-edge forwards here.

Part of the agentdesk runtime (specs/epics/agentdesk-agent-bots).

## Depends on

- cloudflare-d1 (slack_installations, slack_bindings, vault_*)
- agent-runtime-worker (AGENT_RUNTIME: POST /internal/turn)
- membership-worker, policy-worker (authorization)
- VAULT_KEK_V1, OAUTH_STATE_SECRET, SLACK_APP_ID, SLACK_SIGNING_SECRET, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET (runtime secrets)

## Depended on by

- api-edge (installations, install-url, bindings)
- Slack
