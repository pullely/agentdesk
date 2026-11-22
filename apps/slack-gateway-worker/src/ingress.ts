import { isValidSlackRequest } from "@saas/agent-core/slack";
import { createAgentsRepository, createVault, kekRingFromEnv, type SlackInstallation } from "@saas/db/agents";
import { createSqlExecutor } from "@saas/db/d1";
import type { Env } from "./env.js";

// THE PUBLIC INGRESS — Slack's Events API, slash commands and interactivity.
// Order, every request: read the raw body → find the installation by
// (api_app_id, team_id) → verify the HMAC with THAT app's signing secret
// (the shared app's Worker secret, a BYO app's from the vault) → only then
// parse and act. Acknowledge within Slack's 3 s: the turn is handed to the
// thread's ThreadAgent, which persists it and returns at once.

const text = (s: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });

interface Envelope {
  type?: string;
  challenge?: string;
  api_app_id?: string;
  team_id?: string;
  event_id?: string;
  authorizations?: { team_id?: string }[];
  event?: {
    type?: string;
    subtype?: string;
    user?: string;
    bot_id?: string;
    bot_profile?: unknown;
    text?: string;
    channel?: string;
    channel_type?: string;
    ts?: string;
    thread_ts?: string;
  };
}

function peekIds(raw: string, contentType: string | null): { apiAppId: string | undefined; teamId: string | undefined } {
  try {
    if (contentType?.includes("application/x-www-form-urlencoded")) {
      const form = new URLSearchParams(raw);
      const payload = form.get("payload");
      if (payload) {
        const p = JSON.parse(payload) as { api_app_id?: string; team?: { id?: string } };
        return { apiAppId: p.api_app_id, teamId: p.team?.id };
      }
      return { apiAppId: form.get("api_app_id") ?? undefined, teamId: form.get("team_id") ?? undefined };
    }
    const j = JSON.parse(raw) as Envelope;
    return { apiAppId: j.api_app_id, teamId: j.team_id ?? j.authorizations?.[0]?.team_id };
  } catch {
    return { apiAppId: undefined, teamId: undefined };
  }
}

async function signingSecretFor(env: Env, inst: SlackInstallation | null): Promise<string | null> {
  if (inst && inst.mode === "byo" && inst.signingSecretId) {
    const ring = kekRingFromEnv(env as unknown as Record<string, unknown>);
    if (!ring || !env.PLATFORM_DB) return null;
    return createVault(createAgentsRepository(createSqlExecutor(env.PLATFORM_DB)), ring).get(inst.orgId, inst.signingSecretId);
  }
  // The shared app — or a request with no installation yet (url_verification).
  if (inst && env.SLACK_APP_ID && inst.apiAppId !== env.SLACK_APP_ID) return null;
  return env.SLACK_SIGNING_SECRET ?? null;
}

/** Verify a Slack request; answers the installation it belongs to (or null for url_verification). */
async function verify(request: Request, env: Env, raw: string) {
  if (!env.PLATFORM_DB) return { ok: false as const, response: text("Service unavailable", 503) };
  const repo = createAgentsRepository(createSqlExecutor(env.PLATFORM_DB));
  const ids = peekIds(raw, request.headers.get("content-type"));
  const inst = ids.apiAppId && ids.teamId ? await repo.getInstallation(ids.apiAppId, ids.teamId) : null;
  const secret = await signingSecretFor(env, inst);
  if (!secret) return { ok: false as const, response: text("slack_not_configured", 503) };
  const valid = await isValidSlackRequest({
    signingSecret: secret,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    rawBody: raw,
  });
  if (!valid) return { ok: false as const, response: text("Invalid request", 401) };
  return { ok: true as const, inst, repo };
}

export async function handleEvents(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await request.text();
  const v = await verify(request, env, raw);
  if (!v.ok) return v.response;

  let body: Envelope;
  try {
    body = JSON.parse(raw) as Envelope;
  } catch {
    return text("Invalid request", 400);
  }
  if (body.type === "url_verification") return text(String(body.challenge ?? ""));
  if (body.type !== "event_callback" || !body.event) return text("Invalid request", 400);

  // A retry is the same event again: acknowledged, not answered twice.
  if (request.headers.get("x-slack-retry-num")) return text("ok", 200, { "x-slack-no-retry": "1" });

  const inst = v.inst;
  const event = body.event;
  if (!inst || inst.status !== "active") return text("ok");

  if (event.type === "app_uninstalled" || event.type === "tokens_revoked") {
    ctx.waitUntil(v.repo.revokeInstallation(inst.apiAppId, inst.teamId).then(() => undefined));
    return text("ok");
  }

  // Never answer a bot (ourselves included) or an edit/join/etc.
  if (event.bot_id || event.bot_profile || event.subtype || !event.user || !event.channel || !event.ts) return text("ok");
  if (inst.botUserId && event.user === inst.botUserId) return text("ok");

  let trigger: "mention" | "dm" | "all" | null = null;
  if (event.type === "app_mention") trigger = "mention";
  else if (event.type === "message" && event.channel_type === "im") trigger = "dm";
  else if (event.type === "message") trigger = "all";
  if (!trigger) return text("ok");

  // Which bot answers here. A BYO app is one bot; the shared app routes by binding.
  let projectId: string | null = null;
  let envName: "stage" | "prod" = "prod";
  if (inst.mode === "byo" && inst.projectId) {
    projectId = inst.projectId;
    const b = await v.repo.resolveBinding(inst.orgId, inst.teamId, trigger === "dm" ? "" : event.channel, trigger);
    if (b) envName = b.env;
    else if (trigger === "all") return text("ok");
  } else {
    const b = await v.repo.resolveBinding(inst.orgId, inst.teamId, trigger === "dm" ? "" : event.channel, trigger);
    if (!b) return text("ok");
    projectId = b.projectId;
    envName = b.env;
  }
  // A plain channel message with only a mention binding is the app_mention's job.
  if (trigger === "all" && inst.botUserId && event.text?.includes(`<@${inst.botUserId}>`)) return text("ok");
  if (!inst.botTokenSecretId) return text("ok");

  await handOff(env, ctx, {
    orgId: inst.orgId,
    projectId: projectId!,
    env: envName,
    apiAppId: inst.apiAppId,
    teamId: inst.teamId,
    channelId: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    eventTs: event.ts,
    slackUserId: event.user,
    text: event.text ?? "",
    botUserId: inst.botUserId,
    botTokenSecretId: inst.botTokenSecretId,
  });
  return text("ok");
}

/** /slack/commands — `/agent <bot> <question>` starts a thread with that bot. */
export async function handleCommand(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await request.text();
  const v = await verify(request, env, raw);
  if (!v.ok) return v.response;
  const form = new URLSearchParams(raw);
  const inst = v.inst;
  if (!inst || inst.status !== "active" || !inst.botTokenSecretId) return Response.json({ response_type: "ephemeral", text: "agentdesk is not connected to this workspace." });
  const [slug, ...rest] = (form.get("text") ?? "").trim().split(/\s+/);
  const question = rest.join(" ").trim();
  if (!slug || !question) return Response.json({ response_type: "ephemeral", text: "Usage: /agent <bot> <question>" });
  const binding = await v.repo.resolveCommand(inst.orgId, inst.teamId, slug.toLowerCase());
  if (!binding) return Response.json({ response_type: "ephemeral", text: `No bot called "${slug}" answers in this workspace.` });
  const channel = form.get("channel_id") ?? "";
  const user = form.get("user_id") ?? "";

  // A slash command has no message to thread on: post the question as the
  // thread's root (as the bot), and hand the turn to that thread's agent.
  ctx.waitUntil(
    (async () => {
      const ring = kekRingFromEnv(env as unknown as Record<string, unknown>);
      const token = ring ? await createVault(v.repo, ring).get(inst.orgId, inst.botTokenSecretId!) : null;
      if (!token) return;
      const api = (env.SLACK_API_URL ?? "https://slack.com/api/").replace(/\/?$/, "/");
      const res = await fetch(`${api}chat.postMessage`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel, text: `<@${user}> asked: ${question}` }),
      });
      const posted = (await res.json().catch(() => ({}))) as { ok?: boolean; ts?: string };
      if (!posted.ok || !posted.ts) return;
      await handOff(env, ctx, {
        orgId: inst.orgId,
        projectId: binding.projectId,
        env: binding.env,
        apiAppId: inst.apiAppId,
        teamId: inst.teamId,
        channelId: channel,
        threadTs: posted.ts,
        eventTs: posted.ts,
        slackUserId: user,
        text: question,
        botUserId: inst.botUserId,
        botTokenSecretId: inst.botTokenSecretId!,
      });
    })(),
  );
  return Response.json({ response_type: "ephemeral", text: "On it — I'll answer in a thread." });
}

/** /slack/interactivity — block actions (approvals arrive in AD2). */
export async function handleInteractivity(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  const v = await verify(request, env, raw);
  if (!v.ok) return v.response;
  return text("");
}

async function handOff(env: Env, ctx: ExecutionContext, turn: Record<string, unknown>): Promise<void> {
  if (!env.AGENT_RUNTIME) return;
  // The ThreadAgent persists the turn and returns; give it most of Slack's
  // 3 s, and let a slow hand-off finish after the ack rather than drop it.
  const call = env.AGENT_RUNTIME.fetch("https://agent-runtime.internal/internal/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(turn),
  });
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000));
  const first = await Promise.race([call, timeout]);
  if (first === "timeout") ctx.waitUntil(call.then(() => undefined));
}
