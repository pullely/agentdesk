# agentdesk-agent-bots — implementation plan

Milestones land in order. Each is one or more tasks, each task one pull
request on an `orun/<KEY>-<slug>` branch with the `Orun-Task` trailer and the
manifest block, landed when every check is green. A milestone is marked ✅
here when its "done when" list is true, and recorded in
`IMPLEMENTATION-STATUS.md` by the PR that lands its last task.

## AD0 — the spec ✅

This doc set and the first task contract, merged to `main`.

**Done when**
- the five documents are on `main` under `specs/epics/agentdesk-agent-bots/`
- `task_get agentdesk-agent-bots` shows the epic with AD0–AD4, and `AD-1` reads `done`

## AD1 — MVP (landed; see IMPLEMENTATION-STATUS for what is verified live)

The first bot that answers in Slack. Six tasks, because each new Worker is
its own deployable and the tables, the vault and the permissions must be
live before the code that reads them:

| Task | Lands |
|---|---|
| AD-2 foundations | `packages/db` migration `200_agents_foundation` (the eleven tables + `vault_org_keys`); `vault` module in `config-worker` + the model-keys routes; the five permissions in `policy-worker`; wire types in `packages/contracts`; `packages/agent-core` (the ported agent loop, `resolveModel`, the OPA bundle and its tests) |
| AD-3 bots-worker | profile, draft/published config versions, publish, runs read API; api-edge route group |
| AD-4 agent-runtime-worker | `agent-turns` Queue consumer, `ThreadAgent` DO (SQLite memory, compaction, FIFO, pinned version), streaming replies, run records, metering + audit events, playground RPC |
| AD-5 slack-gateway-worker | public `/slack/events`, `/slack/commands`, OAuth install callback, installation store (D1 + KV), per-app signature verification, dedupe, bindings, uninstall handling; shared app only |
| AD-6 connectors-worker | MCP server registry (URL + none/bearer), `McpSession` DO, tool discovery cache, allow/deny grants into OPA input, SSRF guard |
| AD-7 console | Agents area (Slack, model keys, connectors) and the bot builder (Agent, Tools, Channels, Playground, Runs, Publish) |

**Done when**
- migration `200_agents_foundation` is applied on stage and prod D1
- `POST /v1/organizations/{org}/model-keys` stores a key, answers with `last4` only, and the row's ciphertext is not the key
- `GET https://agentdesk-slack-gateway-worker-{stage,prod}.openproduct.workers.dev/health` answers 200 naming the environment
- a correctly signed `event_callback` to stage's `/slack/events` is acked in < 3 s, and a forged one is refused 401
- the playground on a draft config answers, and its run with steps is listed by `GET …/projects/{project}/runs`
- a granted tool on a registered MCP server is called from the playground; an ungranted one is never offered to the model
- the console shows the Agents area and the bot builder on stage and prod

## AD2 — approvals and catalog connectors

`approve` grants become real: the `ThreadAgent` posts Approve/Deny buttons
(only the requester, or a role named in policy, may click), persists the
pending step, suspends, and an alarm expires it; `/slack/interactivity`
resumes the run. OAuth 2.1 catalog connectors (MCP auth spec: discovery,
dynamic client registration, PKCE) for a tested few; per-Slack-user tokens
with an ephemeral "connect your account" link.

**Done when**
- an ask-first tool call posts buttons; Approve resumes the same run, Deny returns a refusal, an unanswered one expires by alarm — each recorded as an `approval` step
- a catalog connector completes OAuth from the console and its tools sync
- a user-scoped connector stores a token per Slack user and acts as that user

## AD3 — custom apps, publishing, plans

Bring-your-own Slack app per bot: a manifest generator, the console wizard,
the installation stored with `mode = byo` and its own signing secret in the
vault, routing by `api_app_id`. Publish shows a diff of draft vs published;
rollback republishes any earlier version. Plans in `billing-worker` (Polar):
bots per org, runs per month, Workers AI token budget, enforced at the
gateway with one ephemeral notice.

**Done when**
- a BYO app's events verify with its own secret and reach its bot
- `POST …/bot/rollback {version: 1}` changes the next turn's behaviour
- a free org past its monthly runs gets one ephemeral notice and no run

## AD4 — hardening

Prompt-injection suite (tool output and Slack content that try to exfiltrate
secrets or call ungranted tools), a load test of queue + DO concurrency,
operator and user docs, the starter agent prompts, and the Slack Marketplace
submission checklist for the shared app.

**Done when**
- the injection suite runs in CI and every case is refused
- the load test report (turns/s, p95 ack latency, DO queue depth) is committed
- the docs and the Marketplace checklist are on `main`

## Sequencing note

AD-2 goes first because every later task reads its tables, its permissions
and its vault, and because `packages/agent-core` (the ported loop) is shared by
the runtime and the playground. AD-3 (bots-worker) precedes AD-4 because the
runtime loads config versions from it. AD-4 precedes AD-5 because the gateway
enqueues onto the runtime's Queue and must not ack events nobody consumes.
AD-6 can land after AD-4 in either order with AD-5; the runtime treats a bot
with no MCP grants as built-ins only. AD-7 lands last in AD1 because it is the
surface over all of them. AD2 needs AD-5's interactivity route and AD-6's
grants. AD3's BYO app needs AD-5's installation model; its quotas need
metering from AD-4. AD4 hardens what exists.

A real Slack round trip needs a Slack app created by a human (the shared
app's signing secret, client id and client secret). Until it exists the
gateway answers `slack_not_configured`, and verification uses signed
synthetic events against a test installation — the same path a real event
takes past the signature check.
