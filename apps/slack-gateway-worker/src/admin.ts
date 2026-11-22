import { createAgentsRepository, createVault, kekRingFromEnv, type SlackBinding, type SlackInstallation } from "@saas/db/agents";
import { createSqlExecutor } from "@saas/db/d1";
import {
  actorOf,
  actorUuid,
  authorize,
  dispatch,
  fail,
  invalid,
  list,
  notFound,
  ok,
  parsePublicId,
  readJson,
  recordAudit,
  toPublicId,
  unauthenticated,
  unavailable,
} from "@saas/worker-kit";
import type { Env } from "./env.js";
import { signState, verifyState } from "./state.js";

// The authenticated half (through api-edge): an org's Slack installations,
// the shared app's "Add to Slack" URL and its OAuth callback, a registered
// (bring-your-own) app, and each bot's channel bindings.

export const SHARED_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "groups:history",
  "im:history",
  "im:read",
  "im:write",
  "chat:write",
  "chat:write.customize",
  "commands",
  "users:read",
];

const INSTALLS = /^\/v1\/organizations\/([^/]+)\/slack\/installations$/;
const INSTALL = /^\/v1\/organizations\/([^/]+)\/slack\/installations\/([^/]+)$/;
const INSTALL_URL = /^\/v1\/organizations\/([^/]+)\/slack\/install-url$/;
const BINDINGS = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/slack\/bindings$/;

export const publicInstallation = (i: SlackInstallation) => ({
  apiAppId: i.apiAppId,
  teamId: i.teamId,
  teamName: i.teamName,
  mode: i.mode,
  projectId: i.projectId ? toPublicId("prj", i.projectId) : null,
  botUserId: i.botUserId,
  status: i.status,
  createdAt: i.createdAt,
});

const publicBinding = (b: SlackBinding) => ({ teamId: b.teamId, channelId: b.channelId, env: b.env, trigger: b.trigger, commandSlug: b.commandSlug });

export function isAdminRoute(pathname: string): boolean {
  return [INSTALLS, INSTALL, INSTALL_URL, BINDINGS].some((re) => re.test(pathname));
}

export async function handleAdmin(request: Request, env: Env, requestId: string): Promise<Response> {
  const actor = actorOf(request);
  if (!actor) return unauthenticated(requestId);
  if (!env.PLATFORM_DB) return unavailable(requestId);
  const db = createSqlExecutor(env.PLATFORM_DB);
  const repo = createAgentsRepository(db);
  const orgGate = async (m: RegExpMatchArray, action: string) => {
    const orgId = parsePublicId(m[1], "org");
    return orgId && (await authorize(env, actor, action, { orgId }, requestId)) ? orgId : null;
  };

  return dispatch(
    request,
    [
      [
        "GET",
        INSTALLS,
        async (m) => {
          const orgId = await orgGate(m, "provider_key.manage");
          if (!orgId) return notFound(requestId);
          return list((await repo.listInstallations(orgId)).map(publicInstallation), requestId);
        },
      ],
      [
        "POST",
        INSTALL_URL,
        async (m) => {
          const orgId = await orgGate(m, "provider_key.manage");
          if (!orgId) return notFound(requestId);
          if (!env.SLACK_CLIENT_ID || !env.OAUTH_STATE_SECRET) {
            return fail("slack_not_configured", "The shared Slack app is not configured in this environment yet", 503, requestId);
          }
          const body = await readJson<{ returnTo?: string }>(request);
          const state = await signState(env.OAUTH_STATE_SECRET, { orgId, actor: actor.subjectId, returnTo: body?.returnTo ?? null });
          const url = new URL("https://slack.com/oauth/v2/authorize");
          url.searchParams.set("client_id", env.SLACK_CLIENT_ID);
          url.searchParams.set("scope", SHARED_SCOPES.join(","));
          url.searchParams.set("state", state);
          url.searchParams.set("redirect_uri", `${new URL(request.url).protocol}//${env.PUBLIC_HOST}/slack/oauth/callback`);
          return ok({ url: url.toString() }, requestId);
        },
      ],
      [
        // Register an app's installation directly: a bring-your-own app (its
        // own signing secret, one bot) or the shared app installed by hand.
        "POST",
        INSTALLS,
        async (m) => {
          const orgId = await orgGate(m, "provider_key.manage");
          if (!orgId) return notFound(requestId);
          const ring = kekRingFromEnv(env as unknown as Record<string, unknown>);
          if (!ring) return fail("vault_not_configured", "The vault key is not configured for this environment", 503, requestId);
          const body = await readJson<{ apiAppId?: string; teamId?: string; teamName?: string; botToken?: string; signingSecret?: string; botUserId?: string; projectId?: string }>(request);
          const fields: Record<string, string[]> = {};
          if (!body?.apiAppId || !/^A[A-Z0-9]{4,}$/.test(body.apiAppId)) fields.apiAppId = ["a Slack app id (A…)"];
          if (!body?.teamId || !/^[TE][A-Z0-9]{4,}$/.test(body.teamId)) fields.teamId = ["a Slack team id (T…)"];
          if (!body?.botToken || !/^xoxb-/.test(body.botToken)) fields.botToken = ["a bot token (xoxb-…)"];
          const byo = Boolean(body?.signingSecret);
          let projectId: string | null = null;
          if (byo) {
            projectId = parsePublicId(body?.projectId, "prj");
            if (!projectId || !(await repo.projectInOrg(orgId, projectId))) fields.projectId = ["a bring-your-own app answers as one bot: the project id"];
          }
          if (Object.keys(fields).length) return invalid(requestId, fields);
          const existing = await repo.getInstallation(body!.apiAppId!, body!.teamId!);
          if (existing && existing.orgId !== orgId) return fail("conflict", "This Slack app is installed for another organization", 409, requestId);
          const vault = createVault(repo, ring);
          const tokenId = await vault.put(orgId, "slack_bot_token", body!.botToken!);
          const secretId = byo ? await vault.put(orgId, "slack_signing_secret", body!.signingSecret!) : null;
          const inst = await repo.upsertInstallation({
            apiAppId: body!.apiAppId!,
            teamId: body!.teamId!,
            orgId,
            enterpriseId: null,
            teamName: body!.teamName ?? null,
            mode: byo ? "byo" : "shared",
            projectId,
            botUserId: body!.botUserId ?? null,
            botTokenSecretId: tokenId,
            signingSecretId: secretId,
            scopes: SHARED_SCOPES.join(","),
            installedBy: actorUuid(actor),
          });
          await recordAudit(db, { actor, requestId, orgId, type: "slack.installed", source: "slack-gateway-worker", subjectKind: "slack_installation", subjectId: `${inst.apiAppId}:${inst.teamId}`, payload: { mode: inst.mode, teamId: inst.teamId } });
          return ok(publicInstallation(inst), requestId, 201);
        },
      ],
      [
        "DELETE",
        INSTALL,
        async (m) => {
          const orgId = await orgGate(m, "provider_key.manage");
          if (!orgId) return notFound(requestId);
          const team = decodeURIComponent(m[2]!);
          const mine = (await repo.listInstallations(orgId)).filter((i) => i.teamId === team || `${i.apiAppId}:${i.teamId}` === team);
          if (mine.length === 0) return notFound(requestId);
          for (const i of mine) await repo.revokeInstallation(i.apiAppId, i.teamId);
          await recordAudit(db, { actor, requestId, orgId, type: "slack.uninstalled", source: "slack-gateway-worker", subjectKind: "slack_installation", subjectId: team, payload: { count: mine.length } });
          return ok({ teamId: team, revoked: mine.length }, requestId);
        },
      ],
      [
        "GET",
        BINDINGS,
        async (m) => {
          const orgId = parsePublicId(m[1], "org");
          const projectId = parsePublicId(m[2], "prj");
          if (!orgId || !projectId || !(await authorize(env, actor, "run.read", { orgId, projectId }, requestId))) return notFound(requestId);
          return list((await repo.listBindings(orgId, projectId)).map(publicBinding), requestId);
        },
      ],
      [
        "PUT",
        BINDINGS,
        async (m) => {
          const orgId = parsePublicId(m[1], "org");
          const projectId = parsePublicId(m[2], "prj");
          if (!orgId || !projectId) return notFound(requestId);
          const [project, allowed] = await Promise.all([
            repo.projectInOrg(orgId, projectId),
            authorize(env, actor, "bot.config.write", { orgId, projectId }, requestId),
          ]);
          if (!project || !allowed) return notFound(requestId);
          const body = await readJson<{ bindings?: unknown }>(request);
          const raw = Array.isArray(body) ? body : Array.isArray(body?.bindings) ? body!.bindings : null;
          if (!raw || (raw as unknown[]).length > 100) return invalid(requestId, { bindings: ["an array of at most 100 bindings"] });
          const teams = new Set((await repo.listInstallations(orgId)).filter((i) => i.status === "active").map((i) => i.teamId));
          const rows: Omit<SlackBinding, "id" | "orgId" | "projectId">[] = [];
          const errors: string[] = [];
          for (const [i, b] of (raw as Record<string, unknown>[]).entries()) {
            const trigger = b.trigger;
            const teamId = String(b.teamId ?? "");
            const envName = b.env === "stage" ? "stage" : b.env === undefined || b.env === "prod" ? "prod" : null;
            if (!teams.has(teamId)) errors.push(`${i}: Slack workspace ${teamId} is not connected to this organization`);
            else if (trigger !== "mention" && trigger !== "all" && trigger !== "dm" && trigger !== "command") errors.push(`${i}: trigger is mention, all, dm or command`);
            else if (!envName) errors.push(`${i}: env is stage or prod`);
            else {
              const channelId = trigger === "dm" || trigger === "command" ? "" : String(b.channelId ?? "");
              const commandSlug = trigger === "command" ? String(b.commandSlug ?? "").toLowerCase() : null;
              if ((trigger === "mention" || trigger === "all") && !/^[CGD][A-Z0-9]{4,}$/.test(channelId)) errors.push(`${i}: a channel id (C…)`);
              else if (trigger === "command" && !/^[a-z][a-z0-9-]{1,30}$/.test(commandSlug ?? "")) errors.push(`${i}: a command slug`);
              else rows.push({ teamId, channelId, env: envName, trigger, commandSlug });
            }
          }
          if (errors.length) return invalid(requestId, { bindings: errors });
          try {
            const saved = await repo.replaceBindings(orgId, projectId, rows);
            await recordAudit(db, { actor, requestId, orgId, projectId, type: "bot.bindings.updated", source: "slack-gateway-worker", subjectKind: "project", subjectId: projectId, payload: { bindings: saved.length } });
            return list(saved.map(publicBinding), requestId);
          } catch {
            return fail("conflict", "A channel or command in this list already answers with another bot", 409, requestId);
          }
        },
      ],
    ],
    requestId,
  );
}

/** GET /slack/oauth/callback — the shared app's install. */
export async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const page = (msg: string, status = 200) =>
    new Response(`<!doctype html><meta charset="utf-8"><title>agentdesk</title><p style="font-family:system-ui">${msg}</p>`, {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET || !env.OAUTH_STATE_SECRET || !env.PLATFORM_DB) return page("Slack is not configured for agentdesk yet.", 503);
  const state = await verifyState(env.OAUTH_STATE_SECRET, url.searchParams.get("state") ?? "");
  if (!state) return page("This install link expired or was tampered with. Start again from agentdesk.", 400);
  const code = url.searchParams.get("code");
  if (!code) return page("Slack did not complete the install.", 400);
  const api = (env.SLACK_API_URL ?? "https://slack.com/api/").replace(/\/?$/, "/");
  const res = await fetch(`${api}oauth.v2.access`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      redirect_uri: `${url.protocol}//${url.host}/slack/oauth/callback`,
    }).toString(),
  });
  const o = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    app_id?: string;
    access_token?: string;
    bot_user_id?: string;
    scope?: string;
    team?: { id?: string; name?: string };
    enterprise?: { id?: string } | null;
  };
  if (!o.ok || !o.app_id || !o.access_token || !o.team?.id) return page("Slack refused the install.", 400);
  const repo = createAgentsRepository(createSqlExecutor(env.PLATFORM_DB));
  const ring = kekRingFromEnv(env as unknown as Record<string, unknown>);
  if (!ring) return page("agentdesk's vault is not configured.", 503);
  const existing = await repo.getInstallation(o.app_id, o.team.id);
  if (existing && existing.orgId !== state.orgId && existing.status === "active") return page("This Slack workspace is already connected to another agentdesk organization.", 409);
  const tokenId = await createVault(repo, ring).put(state.orgId, "slack_bot_token", o.access_token);
  await repo.upsertInstallation({
    apiAppId: o.app_id,
    teamId: o.team.id,
    orgId: state.orgId,
    enterpriseId: o.enterprise?.id ?? null,
    teamName: o.team.name ?? null,
    mode: "shared",
    projectId: null,
    botUserId: o.bot_user_id ?? null,
    botTokenSecretId: tokenId,
    signingSecretId: null,
    scopes: o.scope ?? null,
  });
  await recordAudit(createSqlExecutor(env.PLATFORM_DB), {
    actor: { subjectId: state.actor, subjectType: "user" },
    requestId: crypto.randomUUID(),
    orgId: state.orgId,
    type: "slack.installed",
    source: "slack-gateway-worker",
    subjectKind: "slack_installation",
    subjectId: `${o.app_id}:${o.team.id}`,
    payload: { mode: "shared", teamId: o.team.id },
  });
  if (state.returnTo && /^https:\/\//.test(state.returnTo)) return Response.redirect(state.returnTo, 302);
  return page(`agentdesk is connected to ${o.team.name ?? "your Slack workspace"}. You can close this tab.`);
}
