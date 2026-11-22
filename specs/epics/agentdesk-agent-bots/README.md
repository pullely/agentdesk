# Epic: agentdesk-agent-bots (AD)

**Teams want AI agents in Slack that answer from their own tools, but every
Slack bot today is a single-tenant script: one workspace, one hard-coded
prompt, one model key in an env var, tools fixed in code, and a 30-second
background window that kills any real tool chain. agentdesk makes a bot a
tenant-scoped, versioned product object — one Cirrus project is one bot, with
its own prompt, model, tool grants and Slack identity — and runs each Slack
thread in its own Durable Object behind a queue, so the gateway acks Slack in
milliseconds and the agent has minutes, memory and a policy gate on every
tool call.**

agentdesk is for an org admin who wants several purpose-built agents (support
triage, SRE on-call, docs Q&A) in their Slack without running infrastructure.
When it ships they sign up, add agentdesk to Slack in one click, create a
project per bot, write its system prompt, pick a model (Workers AI by default,
or their own OpenAI / Anthropic key), connect remote MCP servers, grant each
bot a subset of their tools, try it in a browser playground against the draft
config, publish, and watch every run's step trace in the console. Nobody can
do that on Cirrus today: the baseline has tenancy, billing and RBAC, but no
bot, no Slack ingress, no agent runtime and no tool registry.

The agent loop, the WebCrypto signature check, `X-Slack-No-Retry` handling and
the OPA/Rego→WASM tool gate are ported from
[sourceplane/ai-slackbot](https://github.com/sourceplane/ai-slackbot)
`baseline-v3`, itself a Cloudflare port of
[vercel-labs/ai-sdk-slackbot](https://github.com/vercel-labs/ai-sdk-slackbot)
(MIT; see the root `LICENSE` and `NOTICE`).

## Status

| Field | Value |
|-------|-------|
| Status | Draft |
| Cluster | **AD** (AD0–AD4) |
| Owner(s) | `apps/bots-worker`, `apps/slack-gateway-worker`, `apps/agent-runtime-worker`, `apps/connectors-worker` (the resources) · `apps/config-worker` (the vault) · `apps/policy-worker` (the permissions) · `packages/db` (the tables) · `packages/contracts` + `packages/sdk` (the wire) · `apps/web-console-next` (the surface) |
| Builds on | `cirrus-baseline baseline-v29` — identity, membership, projects/environments, policy, config, metering, billing (Polar), events, webhooks, api-edge, web-console-next |
| Changes | Adds four Workers, two Durable Object classes, one Queue, one KV namespace, eleven D1 tables, five permissions and the console's Agents area; no existing bounded context changes shape |
| Decisions locked | (1) A Cirrus project is one bot; stage holds the draft config, prod the published one. (2) One `ThreadAgent` Durable Object per `org:project:team:channel:thread_ts`, fed by the `agent-turns` Queue. (3) Shared multi-workspace Slack app first; bring-your-own app shares the same `slack_installations` row shape. (4) Every model call goes through `resolveModel(org, config)` and Cloudflare AI Gateway. (5) Secrets live only in the config-worker vault, AES-GCM envelope-encrypted per org. |
| Gate | AD1 is the MVP: the first user-visible bot. AD2–AD4 extend it. |
| Shipped as | |

## Read order

1. `design.md` — the resources, the routes, the request lifecycle, the
   surfaces, the alternative rejected, what is out of scope
2. `implementation-plan.md` — the milestones and what "done" means for each
3. `risks-and-open-questions.md` — what could go wrong and what was decided
4. `IMPLEMENTATION-STATUS.md` — what actually shipped (kept distinct from intent)

Architecture of record: "Multi-tenant AI Agent Bots on Cirrus: architecture
and effort" (claude.ai artifact `4F8Uhjq4WCw1DquwGM71G1`, rev 16). This doc
set is its adoption for agentdesk; where they differ, this set wins and says
why.

## Milestones at a glance

| Milestone | What it lands | Done when |
|---|---|---|
| AD0 — the spec | this doc set | merged; `task_get agentdesk-agent-bots` lists AD0–AD4 |
| AD1 — MVP | vault + RBAC + migrations; `bots-worker`; `slack-gateway-worker` (shared app); `agent-runtime-worker` with `ThreadAgent`, queue, memory, streaming, ported loop + OPA; model router (Workers AI + OpenAI/Anthropic BYOK via AI Gateway); `connectors-worker` (remote MCP by URL, bearer, allow/deny grants); console bot builder, playground, runs | a signed Slack event to stage's gateway produces a threaded, streamed reply from a published bot config, with its run and steps visible in the console; the playground answers on the draft config, calling a granted MCP tool |
| AD2 — approvals and catalog connectors | "ask first" grants post Approve/Deny in Slack and resume; OAuth 2.1 catalog connectors; per-Slack-user tokens | an ask-first tool call suspends, an Approve click resumes the same run, a Deny returns a refusal, and an alarm expires an unanswered one |
| AD3 — custom apps, publishing, plans | BYO Slack app per bot + manifest generator; publish diff + rollback; quotas and plans in Polar | a bot answers under its own Slack app; rollback to v1 changes the next turn's behaviour; a free org over its run quota gets one ephemeral notice |
| AD4 — hardening | prompt-injection suite, queue/DO load test, docs, Slack Marketplace prep | the injection suite and load test run green in CI; docs and the Marketplace checklist are published |
