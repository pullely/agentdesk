# agentdesk-agent-bots (AD) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| AD0 — the spec | ✅ Shipped 2026-11-22 | pullely/agentdesk#3 |
| AD1 — MVP | Landed on stage and prod; end-to-end Slack and playground verification waits on two human steps (`WAITING.md`) | #5 (AD-2), #6 (AD-3), #7 (AD-11), #8 (AD-4), #9 (AD-12), #10 (AD-5), #11 (AD-6), AD-7 (this PR) |
| AD2 — approvals and catalog connectors | Not started | |
| AD3 — custom apps, publishing, plans | Not started | |
| AD4 — hardening | Not started | |

## AD1 — what is live

| Component | stage / prod | Verified |
|---|---|---|
| migration `200_agents_foundation` | applied by db-migrate on both | db-migrate jobs green in the AD-2 convergence; tests on SQLite |
| config-worker model keys + vault | deployed | `/v1/organizations/{org}/model-keys` reaches config-worker (401 without a session); 206 tests |
| bots-worker | `agentdesk-bots-worker-{stage,prod}` | `…/projects/{p}/bot` through api-edge answers 401 without a session; 10 tests |
| agent-runtime-worker (`ThreadAgent`) | `agentdesk-agent-runtime-worker-{stage,prod}` | converged; 11 tests incl. the ThreadAgent FIFO, pinning, streaming |
| slack-gateway-worker | `https://agentdesk-slack-gateway-worker-{stage,prod}.openproduct.workers.dev` | `/health` 200 on both; a forged event is refused; 13 tests |
| connectors-worker (`McpSession`) | `agentdesk-connectors-worker-{stage,prod}` | converged with #11; 6 tests |
| console Agents area + bot builder | `https://agentdesk-web-console-next-{stage,prod}.openproduct.workers.dev` | `next build` green; nav tests updated |

**Not yet verified live:** a real Slack thread answered by a published bot,
and a playground run through the console. Both need a signed-in user, and
the Slack one needs the shared Slack app (or a registered one). Sign-in to
agentdesk itself is not possible yet: the baseline sends magic links from an
unverified example domain and no OAuth provider is configured. Both steps are
in `WAITING.md`.

## Departures from the design

1. **Turns reach the `ThreadAgent` without a Queue** (design §4 step 5). The
   gateway hands the turn to agent-runtime over a service binding; the DO
   persists it in its SQLite FIFO (deduped on the Slack event ts), returns,
   and its alarm runs the loop. Same decoupling — Slack is acked after a
   durable write, turns run in order per thread, minutes per run — and no
   Queue to provision with a deploy token whose scopes are not ours to see.
2. **No KV in the Slack hot path** (design §4 steps 1–2). The installation
   lookup is one D1 read; event dedupe is the ThreadAgent's unique event ts.
3. **Tool grant routes live in bots-worker** (design §3), beside the config
   they belong to (the architecture doc lists tool grants under bots-worker);
   connectors-worker owns servers and discovery.
4. **The vault is a module** (`@saas/db/agents/vault`) imported by the three
   Workers that hold `VAULT_KEK_V1` (config-worker, agent-runtime,
   slack-gateway, plus connectors for bearer tokens), not an RPC surface on
   config-worker.
5. **BYOK reaches AI Gateway by the URL the AI binding gives**
   (`env.AI.gateway(id).getUrl()`), so the runtime holds no account id (#9).
6. **Thread compaction is a bounded digest**, not a model summary: past 40
   messages the oldest fold into a 6 KB digest the next turn reads.
7. **`approve` grants are refused in AD1** with a reason; the Slack approval
   flow is AD2.
8. **Solo mode is off** (`SOLO_MODE=false`, `NEXT_PUBLIC_SOLO_MODE=false`):
   the baseline shipped single-user; agentdesk needs orgs and projects.
9. **New**: `@saas/worker-kit` (auth, envelopes, audit for the new Workers)
   and `@saas/agent-core` (the ported loop, policy, model router).

## Fixes made along the way

- BASE-3 (#2): the bootstrap was given subdomain `rahulvarghesepullely`, but
  the account's `openproduct` Cloudflare connection deployed the fleet to
  `*.openproduct.workers.dev`.
- AD-11 (#7): a new Worker's bindings named Workers added in the same
  landing (Cloudflare 10143); fleet-stubs now runs in their pre-deploy.
- AD-12 (#9): `CLOUDFLARE_ACCOUNT_ID` was bound twice, which failed `orun
  plan` on main; the agent Workers' rendered `wrangler.jsonc` is gitignored.
- AD-2 (#5): the console's form resolver picked up zod 4 by hoisting;
  pinned to zod 3 with `packageExtensions`.
