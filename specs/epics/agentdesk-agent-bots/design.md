# agentdesk-agent-bots — design

Four new bounded contexts on Cirrus — `bots`, `slack-gateway`,
`agent-runtime`, `connectors` — plus a `vault` inside `config-worker`.
Everything generic (identity, orgs, members, RBAC, projects and environments,
metering, billing, audit events, webhooks, the edge, the console) is the
baseline's and is reused unchanged.

## 1. Tenancy

Cirrus models **org → projects → environments**; agentdesk maps onto it
without a new hierarchy.

| Cirrus entity | Bot meaning | Owner |
|---|---|---|
| Organization (`membership-worker`) | the customer: members, roles, plan, BYOK keys, MCP connections, Slack installations | existing |
| Project (`projects-worker`) | **one bot**: profile, versioned config, tool grants, Slack bindings | existing + `bots-worker` |
| Environment `stage` / `prod` | `stage` runs the **draft** config (playground, a test channel); `prod` runs the **published** one | existing |
| Slack workspace installation | linked to one org; one workspace can hold several of its bots | new, `slack-gateway-worker` |
| Channel / DM binding | which bot answers where | new, `slack-gateway-worker` |

Rules, enforced in three places:

1. **Every D1 row carries `org_id`**, and `project_id` where it applies; every
   repository query filters on it.
2. **Every Durable Object name is prefixed `org_id:project_id`** —
   `ThreadAgent` is `org:project:team:channel:thread_ts`, `McpSession` is
   `org:server` (or `org:server:slack_user` for user-scoped tokens).
3. **`policy-worker` checks every console and API call.** New permissions,
   deny by default:

| Permission | Grants | Default roles |
|---|---|---|
| `bot.config.write` | edit a bot's profile and draft config, run the playground | owner, admin, developer |
| `bot.publish` | publish a config version to prod, roll back | owner, admin |
| `connector.manage` | add/remove MCP servers, sync tools, edit grants | owner, admin |
| `provider_key.manage` | add/verify/rotate/remove BYOK model keys, connect Slack | owner, admin |
| `run.read` | list runs and read their step traces | owner, admin, developer, viewer |

**Config is versioned and immutable once published.** A thread pins the
version it started with, so an edit mid-conversation never changes a turn in
flight.

## 2. The resources

Id prefixes follow the baseline's `<prefix>_<ulid-ish>` convention.

```
bots_profiles                           one row per project
  project_id      text PK    prj_…
  org_id          text       org_…
  display_name    text
  description     text
  avatar_url      text       (R2 upload later; a URL for now)
  created_at, updated_at

bots_config_versions                    immutable once status=published
  id              text PK    bcv_…
  org_id, project_id
  version         integer    1,2,3… per project
  status          text       draft | published | superseded
  system_prompt   text       may use {{user_name}} {{channel}} {{date}} {{bot_name}}
  model_ref       text       "workers-ai:@cf/moonshotai/kimi-k2.6" | "openai:gpt-4o" | "anthropic:claude-…"
  provider_key_id text NULL  llm_provider_keys.id for BYOK
  params_json     text       { temperature, maxSteps, maxOutputTokens }
  tool_grants_json text      denormalised snapshot of connectors_grants at publish
  policy_ref      text       "builtin:v1" (the ported Rego bundle)
  created_by, created_at, published_at
  UNIQUE(project_id, version)

slack_installations                     shared and BYO apps alike
  api_app_id, team_id   PK (composite)
  org_id
  enterprise_id   text NULL
  mode            text       shared | byo
  project_id      text NULL  set for a BYO app (one bot)
  bot_user_id     text
  bot_token_secret_id   text  vault_secrets.id
  signing_secret_id     text  vault_secrets.id (BYO; the shared app's is a Worker secret)
  scopes          text
  status          text       active | revoked
  installed_by, created_at, updated_at

slack_bindings
  id              text PK    sbd_…
  org_id, team_id
  channel_id      text NULL  NULL = the bot's DMs
  project_id
  trigger         text       mention | all | command
  UNIQUE(team_id, channel_id, trigger)

llm_provider_keys
  id              text PK    lpk_…
  org_id, provider (openai|anthropic|google|openai-compatible), label, base_url NULL
  secret_id, last4, status (unverified|valid|invalid), last_verified_at

connectors_servers
  id              text PK    mcs_…
  org_id, name, url, transport (streamable-http|sse)
  auth_type       text       none | bearer | oauth | user-oauth
  secret_id       text NULL
  status          text       active | error | disabled
  tools_cache_json text      [{ name, description, inputSchema, descriptionHash }]
  tools_synced_at, last_error

connectors_grants
  id              text PK    mcg_…
  org_id, project_id, server_id
  tool_name       text       a tool name, or "*"
  mode            text       allow | approve | deny
  arg_constraints_json text NULL  { "<arg>": "<glob>" }
  description_hash text NULL the tool description hash the admin approved
  UNIQUE(project_id, server_id, tool_name)

connectors_user_tokens   (AD2)
  org_id, server_id, slack_user_id, secret_id   PK(server_id, slack_user_id)

vault_secrets
  id              text PK    vsc_…
  org_id, purpose (llm_key|slack_bot_token|slack_signing_secret|mcp_token|mcp_oauth)
  ciphertext, iv           base64, AES-256-GCM under the org's DEK
  created_at, rotated_at

vault_org_keys           (per-org DEK, wrapped)
  org_id PK, dek_wrapped, dek_iv, kek_version, created_at

agent_runs
  id              text PK    run_…
  org_id, project_id, config_version_id, env
  source          text       slack | playground | api
  team_id, channel_id, thread_ts, slack_user_id   (NULL for playground)
  model, status (running|completed|failed|suspended)
  tokens_in, tokens_out, cost_micros, latency_ms, error
  started_at, finished_at

agent_run_steps
  run_id, seq     PK
  org_id
  kind            text       llm | tool | approval
  tool, policy_decision (allow|deny|approve), duration_ms
  redacted_io_json text     inputs/outputs truncated to 2 KB, secrets scrubbed
```

Inside each `ThreadAgent` (DO SQLite): `messages(role, content, ts)`, a
compacted `summary`, the pinned `config_version_id`, the FIFO `turns` queue,
`pending_approvals`, and the reply message `ts` being streamed into. Idle
threads expire after 30 days by alarm.

**Vault.** A per-org 256-bit data key (DEK) encrypts each secret with
AES-GCM (WebCrypto). The DEK is wrapped by a key-encryption key (KEK) held as
the `VAULT_KEK_V1` Worker secret on `config-worker` and `agent-runtime-worker`
(base64, 32 bytes); `kek_version` allows rotation to `VAULT_KEK_V2` with a
rewrap job. `config-worker` encrypts and stores; only `agent-runtime-worker`
(models, MCP) and `slack-gateway-worker` (Slack tokens) decrypt, per call,
in memory, never logged. The API returns a secret's `label` and `last4`, never
its value.

## 3. The API

Envelopes follow the baseline's `{ data, meta }` / `{ error: { code,
message } }`. All routes under `/v1/organizations/{org}` go through
`api-edge` (session or API key) and are authorised in the owning Worker by
`policy-worker`.

```
# bots-worker — profile, config, publish, playground          perm
GET    /v1/organizations/{org}/projects/{project}/bot                     run.read
PUT    /v1/organizations/{org}/projects/{project}/bot                     bot.config.write
GET    /v1/organizations/{org}/projects/{project}/bot/versions            run.read
GET    /v1/organizations/{org}/projects/{project}/bot/draft               run.read
PUT    /v1/organizations/{org}/projects/{project}/bot/draft               bot.config.write
POST   /v1/organizations/{org}/projects/{project}/bot/publish             bot.publish
POST   /v1/organizations/{org}/projects/{project}/bot/rollback {version}  bot.publish   (AD3)
POST   /v1/organizations/{org}/projects/{project}/bot/playground {messages}  bot.config.write
GET    /v1/organizations/{org}/projects/{project}/runs                    run.read
GET    /v1/organizations/{org}/runs/{run}                                  run.read

# config-worker — model keys (vault)
GET    /v1/organizations/{org}/model-keys                                  provider_key.manage
POST   /v1/organizations/{org}/model-keys {provider,label,key,baseUrl?}    provider_key.manage  (verified on save)
POST   /v1/organizations/{org}/model-keys/{id}/verify                      provider_key.manage
DELETE /v1/organizations/{org}/model-keys/{id}                             provider_key.manage

# connectors-worker — MCP servers and grants
GET    /v1/organizations/{org}/connectors                                  connector.manage
POST   /v1/organizations/{org}/connectors {name,url,authType,token?}       connector.manage
POST   /v1/organizations/{org}/connectors/{id}/sync                        connector.manage
DELETE /v1/organizations/{org}/connectors/{id}                             connector.manage
GET    /v1/organizations/{org}/projects/{project}/grants                   run.read
PUT    /v1/organizations/{org}/projects/{project}/grants [{serverId,tool,mode,argConstraints?}]  connector.manage

# slack-gateway-worker — installations and bindings (authenticated, via api-edge)
GET    /v1/organizations/{org}/slack/installations                         provider_key.manage
POST   /v1/organizations/{org}/slack/install-url                           provider_key.manage  → Slack OAuth URL with signed state
DELETE /v1/organizations/{org}/slack/installations/{team}                  provider_key.manage
GET    /v1/organizations/{org}/projects/{project}/slack/bindings           run.read
PUT    /v1/organizations/{org}/projects/{project}/slack/bindings           bot.config.write

# slack-gateway-worker — public ingress (its own workers.dev host, NOT behind api-edge)
POST   /slack/events          Events API (url_verification, event_callback)
POST   /slack/interactivity   block actions (approvals, AD2)
POST   /slack/commands        /agent <bot> <text>
GET    /slack/oauth/callback  OAuth v2 install → slack_installations
GET    /health
```

Error codes added: `bot_not_found`, `config_immutable`, `no_draft`,
`model_key_invalid`, `connector_unreachable`, `connector_url_refused` (SSRF),
`slack_not_configured`, `quota_exceeded`.

## 4. The request lifecycle

1. **Slack → `slack-gateway-worker` `/slack/events`.** Read `api_app_id` and
   `team_id` from the raw body; look up the installation (KV, falling back to
   D1). Verify the HMAC (`v0:<ts>:<body>`, WebCrypto, ±5 min) with that app's
   signing secret — the shared app's from its Worker secret, a BYO app's from
   the vault. Nothing is parsed further before this passes.
2. **Dedupe and ack.** `event_id` into KV with a 1-hour TTL; a repeat or an
   `X-Slack-Retry-Num` gets `200` + `X-Slack-No-Retry: 1`; the bot's own
   messages are dropped. Answer `200` in milliseconds.
3. **Resolve the bot.** An @mention in a bound channel → that binding's
   project; a DM → the team's DM binding; `/agent <bot>` → the project by
   slug. No match, no reply.
4. **Check quota** (`metering-worker`, cached 60 s). Over the limit → one
   ephemeral notice (AD3 enforces; AD1 records).
5. **Enqueue** `{ org, project, env, configVersionId, team, channel,
   threadTs, user, text, eventTs, apiAppId }` on the `agent-turns` Queue.
6. **Queue consumer → `ThreadAgent`.** The DO appends the turn to its FIFO
   and processes turns one at a time; the first turn pins the published config
   version.
7. **Build context.** History from DO SQLite (Slack's `conversations.replies`
   only on a cold thread), compacted to a summary past 40 messages; the
   system prompt with its variables rendered, an admin preamble that a bot
   prompt cannot remove, a per-user identity line, and the granted tools.
8. **Agent loop** — the ported ai-slackbot loop (AI SDK `streamText`,
   `stopWhen: stepCountIs(maxSteps)`). Every tool call passes the OPA WASM
   policy with the bot's grants as input: **allow** → run it (built-in, or
   MCP via `McpSession`); **approve** → AD2 posts Approve/Deny and suspends;
   AD1 treats `approve` as deny with a reason; **deny** → a refusal to the
   model.
9. **Stream the reply.** Post "is thinking…" in the thread, then
   `chat.update` it every ~1 s of new text; the final edit carries the
   ai-slackbot tool footer. Bot identity per message via
   `chat:write.customize` (`username`, `icon_url`).
10. **Record the run.** `agent_runs` + `agent_run_steps` to D1,
    `bot.run.completed` to `events-worker`, a usage record (runs, tokens,
    tool calls) to `metering-worker`.

The **playground** runs the same loop in `agent-runtime-worker` over RPC from
`bots-worker`, on the draft config, returning the reply and the step trace
instead of posting to Slack (`source = playground`).

## 5. The model layer

`resolveModel(org, config)` in `packages/agent-core` returns an AI SDK
`LanguageModel`:

| `model_ref` | Provider | Who pays | Metering |
|---|---|---|---|
| `workers-ai:<id>` (default `@cf/moonshotai/kimi-k2.6`) | `workers-ai-provider` on the `AI` binding, `gateway: { id }` | Sourceplane | tokens against the plan's budget |
| `openai:<id>` | `@ai-sdk/openai`, `baseURL` = the AI Gateway's `openai` endpoint | customer (BYOK) | runs and tool calls; tokens recorded |
| `anthropic:<id>` | `@ai-sdk/anthropic` via the gateway's `anthropic` endpoint | customer | same |
| `openai-compatible:<id>` | `@ai-sdk/openai` with the key's `base_url` (AD3) | customer | same |

Every call carries `cf-aig-metadata: {org, project, run}`; one gateway per
environment (`agentdesk-stage`, `agentdesk-prod`), created on first use by
the account (AI Gateway auto-creates a gateway named in the request). Workers
AI models are allow-listed to tool-calling ones. Keys are verified on save
with a model-list call.

## 6. MCP connectivity

The org registers a remote MCP server once (`connectors_servers`); each bot
is granted a subset of its tools (`connectors_grants`). `agent-runtime` is
the MCP client: the AI SDK MCP client over Streamable HTTP, inside the
`McpSession` DO hosted by `connectors-worker`, so connections and refreshed
tokens are reused across turns.

- **Discovery:** `tools/list` on add and on `sync`, cached in
  `tools_cache_json` with a hash per description. A changed description
  clears that tool's `description_hash` match, and the grant stops applying
  until an admin re-approves it (tool poisoning guard).
- **Only granted tools reach the model.** Grants compile into the OPA input:
  `{ grants: { "<server>/<tool>": { mode, argConstraints } } }`.
- **Safety rails:** `https` only; refuse private, loopback, link-local and
  `*.workers.dev`-of-another-tenant hosts (resolved at add and at call); 15 s
  per call; 64 KB output cap; tool output is wrapped as untrusted content in
  the prompt; max steps per turn; at most 8 concurrent MCP sessions per org.
- **Built-in tools** (the ported ai-slackbot set — getWeather, throwDice,
  sandboxed bash/readFile/writeFile, searchWeb with a BYO Exa key) are
  offered through the same grant model as a server named `builtin`.

## 7. The console

Org level, a new **Agents** area:
- **Slack** — connected workspaces, "Add to Slack" (shared app), uninstall.
- **Model keys** — add/verify/remove BYOK keys (label + last4), Workers AI usage.
- **Connectors** — add a remote MCP URL (none/bearer), its tools, sync, health.
- **Usage** — runs, tokens, tool calls by bot (`metering-worker`).

Project level, the project page becomes a **bot builder**:
- **Agent** — name, description, avatar URL; system prompt editor with
  variables; model picker (only providers with a valid key); temperature;
  max steps.
- **Tools** — granted tools by server, allow / deny (ask first in AD2).
- **Channels** — bindings: channel + trigger, DMs.
- **Playground** — chat with the draft config, with the tool-call trace.
- **Runs** — list with status, model, tokens, latency; a run's step trace.
- **Publish** — publish the draft (AD1); diff and rollback (AD3).

## 8. Events, secrets and integrations

Audit events to `events-worker`: `bot.config.updated`, `bot.published`,
`bot.rolled_back`, `model_key.added|removed|verified`,
`connector.added|removed|synced`, `grant.changed`, `slack.installed|uninstalled`,
`bot.run.completed`, `tool.approval.decided`. Outgoing webhooks (optional):
`run.completed`, `tool.approval_requested`.

Worker secrets (set with `orun secrets set`, by name only): `VAULT_KEK_V1`
(config-worker, agent-runtime-worker, slack-gateway-worker),
`SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`
(slack-gateway-worker; the shared app). Slack `app_uninstalled` /
`tokens_revoked` wipe the installation's tokens.

## 9. The alternative rejected

**Keep ai-slackbot's single Worker and add tenancy to it** — one Hono app
answering `/api/events` with `waitUntil`, a table of workspaces, and env-var
keys per tenant. Rejected: `waitUntil` caps background work at ~30 s after the
response, which a multi-step MCP tool chain exceeds; there is no place for
per-thread memory or FIFO ordering of turns; and every new tenant would need a
redeploy for its secrets. A queue plus one Durable Object per thread removes
all three, and Cirrus already provides the tenancy the single Worker would have
to reinvent.

Also rejected for now: **Chat SDK** as the Slack layer (worth it only if Teams
or Discord are near-term; the direct Events API code is smaller and proven on
Workers), and **AI Gateway stored provider keys** instead of our vault (removes
the vault from the model path but per-org keys at our tenant count need
checking against its limits; revisit in AD3).

## 10. Out of scope

- Hosted customer-written MCP servers (Workers for Platforms) — later epic.
- Teams, Discord, email channels — the `ThreadAgent` is channel-agnostic, the
  adapters are not built.
- Exposing a bot as an MCP server or `POST /v1/bots/:id/chat` — later.
- Python/JS in the bash tool (Cloudflare Sandbox) — later, as a paid tool.
- A template gallery of starter agents — AD4 ships the prompts as docs only.
