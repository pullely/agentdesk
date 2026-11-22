# bots-worker — runbook

- **Playground answers 503 runtime_unavailable:** agent-runtime-worker is not deployed in that environment (or still the fleet-stub placeholder).
- **Publish answers 409 no_draft:** save the draft first (PUT /bot/draft).
- **A grant is refused with 'sync it first':** run POST /connectors/{id}/sync so the tool is in the cache.
- `curl https://<edge>/v1/organizations/{org}/projects/{p}/bot` with a session token shows the profile, draft and published version.
