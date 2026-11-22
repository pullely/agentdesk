# agentdesk-agent-bots — risks and open questions

Each entry is a letter, a title, and a state: **RISK** (open, with a
mitigation), **RESOLVED** (decided; say what and why), **ACCEPTED** (a cost we
carry knowingly), **SETTLED** (decided for now; revisit on a stated cadence).

## AD-A — Slack history rate limits on the shared app (RISK, mitigated)

Since 2025 Slack limits `conversations.history`/`replies` for distributed
apps that are not Marketplace-approved, so a shared-app bot could answer with
little context. Mitigation: the `ThreadAgent` caches the thread in DO SQLite
and calls `conversations.replies` only on a cold thread; Marketplace listing
(AD4); a BYO app (AD3) for heavy users, since internal apps are less affected.

## AD-B — Prompt injection through MCP tool output (RISK, mitigated)

A tool result or a Slack message can instruct the model to exfiltrate data
through a write tool. Mitigation: tool output and Slack content are wrapped
as untrusted in the prompt; write tools default to deny in AD1 and to "ask
first" from AD2; argument constraints; an admin preamble a bot prompt cannot
remove; every tool decision recorded and audited; secrets never enter the
prompt. AD4 adds a CI suite of injection cases.

## AD-C — Workers AI tool-calling quality varies by model (RISK, mitigated)

A weak model loops or calls tools badly. Mitigation: an allow-list of tested
tool-calling models (default `@cf/moonshotai/kimi-k2.6`, the one ai-slackbot
proved), `stopWhen` step caps, and BYOK as the upgrade.

## AD-D — Free-tier abuse of Workers AI (RISK, mitigated)

Mitigation: per-org monthly token budget and run quota (AD3), per-workspace
rate at the gateway, and verified-email signup from the baseline.

## AD-E — MCP OAuth inconsistencies across servers (RISK, mitigated)

Mitigation: AD1 ships bearer and none only; AD2 adds OAuth servers one at a
time from a small tested catalog.

## AD-F — The shared Slack app needs a human (ACCEPTED)

Creating the shared app at api.slack.com (its signing secret, client id and
secret) needs a person signed in to Slack. Until then the gateway answers
`slack_not_configured` and is verified with signed synthetic events. The
step is listed in `WAITING.md` at the repository root.

## AD-G — Secrets custody: our vault vs AI Gateway stored keys (SETTLED)

Decision: our vault in `config-worker` (per-org DEK, KEK as a Worker secret,
versioned). AI Gateway's stored keys would keep keys out of our code path but
its per-gateway key limits at our tenant count are unverified. Revisit at AD3.

## AD-H — Stage maps to a test channel, not a second Slack app (RESOLVED)

A project's stage environment runs the draft config; in Slack it answers in
channels bound with `env = stage` (a test channel), on the same app. A second
app per environment doubles every install for no isolation the data model
does not already give.

## AD-I — Bot identity on the shared app (ACCEPTED)

On the shared app every bot shares one Slack bot user and @handle; only the
display name and icon differ (`chat:write.customize`). Routing is by channel
binding or `/agent <bot>`. Full identity is the BYO app (AD3).

## AD-J — The ported loop's dependencies on Workers (RISK, mitigated)

`bash-tool`/`just-bash`, `@ai-sdk/policy-opa` and `@open-policy-agent/opa-wasm`
run on Workers today in ai-slackbot `baseline-v3` (the WASM is bundled as a
module; just-bash is aliased to a vendored build). Mitigation: the versions
are pinned exactly as there, and `packages/agent-core`'s tests run the policy
and the loop against a fake model.

## AD-K — Durable Object + Queue cost at scale (ACCEPTED)

Each Slack thread is a DO; idle threads expire after 30 days by alarm, and a
DO costs nothing while idle. The queue adds one message per turn. The load
test (AD4) measures it.

## AD-L — Open decisions carried (SETTLED, revisit at AD3)

- Shared app name and Marketplace listing at launch — default "agentdesk",
  listing prepared in AD4.
- Free-tier Workers AI budget — measured from AD1 runs before AD3 sets it.
- Hosted custom MCP (Workers for Platforms) — out of this epic.
