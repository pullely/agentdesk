import { jest } from "@jest/globals";
import type { DatabaseSync } from "node:sqlite";
import worker from "@slack-gateway-worker/index";
import { signState, verifyState } from "@slack-gateway-worker/state";
import type { Env } from "@slack-gateway-worker/env";
import { slackSignature } from "@saas/agent-core/slack";
import { createAgentsRepository, createVault, kekRingFromEnv } from "@saas/db/agents";
import { createSqlExecutor } from "@saas/db/d1";
import { d1Over, migratedDatabase } from "./sqlite-d1";

// agentdesk AD-5: the Slack gateway against a real SQLite D1.

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
const PRJ = "cccccccc-0000-4000-8000-000000000003";
const hex = (u: string) => u.replace(/-/g, "");
const KEK = Buffer.from(new Uint8Array(32).fill(5)).toString("base64");
const SHARED_SECRET = "shared-signing-secret";
const BYO_SECRET = "byo-signing-secret";

const ctx = () => {
  const pending: Promise<unknown>[] = [];
  return { pending, waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext & { pending: Promise<unknown>[] };
};

async function setup() {
  const db: DatabaseSync = migratedDatabase();
  db.prepare("INSERT INTO projects_projects (id, org_id, name, slug, slug_lower) VALUES (?, ?, ?, ?, ?)").run(PRJ, ORG, "Ops bot", "ops", "ops");
  const repo = createAgentsRepository(createSqlExecutor(d1Over(db) as never));
  const vault = createVault(repo, kekRingFromEnv({ VAULT_KEK_V1: KEK })!);
  const tokenId = await vault.put(ORG, "slack_bot_token", "xoxb-shared");
  await repo.upsertInstallation({ apiAppId: "ASHARED1", teamId: "T00001", orgId: ORG, enterpriseId: null, teamName: "Acme", mode: "shared", projectId: null, botUserId: "UBOT1", botTokenSecretId: tokenId, signingSecretId: null, scopes: "" });
  await repo.replaceBindings(ORG, PRJ, [
    { teamId: "T00001", channelId: "C00001", env: "prod", trigger: "mention", commandSlug: null },
    { teamId: "T00001", channelId: "", env: "stage", trigger: "dm", commandSlug: null },
    { teamId: "T00001", channelId: "", env: "prod", trigger: "command", commandSlug: "ops" },
  ]);
  const turns: any[] = [];
  const runtime = { fetch: jest.fn(async (_u: string, init?: RequestInit) => (turns.push(JSON.parse(String(init?.body))), Response.json({ data: { queued: true } }, { status: 202 }))) } as unknown as Fetcher;
  const policy = { fetch: jest.fn(async () => Response.json({ data: { allow: true } })) } as unknown as Fetcher;
  const membership = { fetch: jest.fn(async () => Response.json({ data: { memberships: [] } })) } as unknown as Fetcher;
  const env: Env = {
    ENVIRONMENT: "stage",
    PUBLIC_HOST: "gw.test",
    PLATFORM_DB: d1Over(db) as unknown as D1Database,
    AGENT_RUNTIME: runtime,
    POLICY_WORKER: policy,
    MEMBERSHIP_WORKER: membership,
    SLACK_APP_ID: "ASHARED1",
    SLACK_SIGNING_SECRET: SHARED_SECRET,
    SLACK_CLIENT_ID: "123.456",
    SLACK_CLIENT_SECRET: "client-secret",
    OAUTH_STATE_SECRET: "state-secret",
    VAULT_KEK_V1: KEK,
    SLACK_API_URL: "https://slack.test/api/",
  };
  return { db, repo, vault, env, turns, runtime };
}

async function signed(path: string, body: string, secret = SHARED_SECRET, extra: Record<string, string> = {}, contentType = "application/json") {
  const ts = String(Math.floor(Date.now() / 1000));
  return new Request(`https://gw.test${path}`, {
    method: "POST",
    headers: { "content-type": contentType, "x-slack-request-timestamp": ts, "x-slack-signature": await slackSignature(secret, ts, body), ...extra },
    body,
  });
}

const event = (e: Record<string, unknown>, app = "ASHARED1", team = "T00001") =>
  JSON.stringify({ type: "event_callback", api_app_id: app, team_id: team, event_id: "Ev1", event: e });

describe("slack-gateway-worker (AD-5)", () => {
  it("answers health, naming what is configured", async () => {
    const { env } = await setup();
    const r = (await (await worker.fetch(new Request("https://gw.test/health"), env, ctx())).json()) as any;
    expect(r.data).toMatchObject({ status: "ok", slack: "configured", oauth: true, vault: true, runtime: true });
  });

  it("verifies before anything: a forged event is refused, url_verification is echoed", async () => {
    const { env, turns } = await setup();
    const body = event({ type: "app_mention", user: "U1", text: "<@UBOT1> hi", channel: "C00001", ts: "1.1" });
    const forged = await signed("/slack/events", body, "wrong-secret");
    expect((await worker.fetch(forged, env, ctx())).status).toBe(401);
    const unsigned = new Request("https://gw.test/slack/events", { method: "POST", body });
    expect((await worker.fetch(unsigned, env, ctx())).status).toBe(401);
    expect(turns).toHaveLength(0);
    const challenge = await signed("/slack/events", JSON.stringify({ type: "url_verification", challenge: "abc123" }));
    const r = await worker.fetch(challenge, env, ctx());
    expect(await r.text()).toBe("abc123");
  });

  it("hands a mention in a bound channel to the thread's agent, fast", async () => {
    const { env, turns } = await setup();
    const started = Date.now();
    const r = await worker.fetch(await signed("/slack/events", event({ type: "app_mention", user: "U1", text: "<@UBOT1> hi", channel: "C00001", ts: "1.1" })), env, ctx());
    expect(r.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ orgId: ORG, projectId: PRJ, env: "prod", teamId: "T00001", channelId: "C00001", threadTs: "1.1", eventTs: "1.1", slackUserId: "U1", botUserId: "UBOT1" });
    expect(turns[0].botTokenSecretId).toBeTruthy();
  });

  it("answers DMs through the DM binding, threads replies, and ignores unbound channels and bots", async () => {
    const { env, turns } = await setup();
    await worker.fetch(await signed("/slack/events", event({ type: "message", channel_type: "im", user: "U1", text: "hello", channel: "D00001", ts: "2.2", thread_ts: "2.0" })), env, ctx());
    expect(turns[0]).toMatchObject({ env: "stage", threadTs: "2.0", channelId: "D00001" });
    await worker.fetch(await signed("/slack/events", event({ type: "app_mention", user: "U1", text: "<@UBOT1> hi", channel: "C99999", ts: "3.3" })), env, ctx());
    await worker.fetch(await signed("/slack/events", event({ type: "message", channel_type: "im", bot_id: "B1", text: "loop", channel: "D00001", ts: "4.4" })), env, ctx());
    await worker.fetch(await signed("/slack/events", event({ type: "message", channel_type: "im", user: "UBOT1", text: "me", channel: "D00001", ts: "5.5" })), env, ctx());
    await worker.fetch(await signed("/slack/events", event({ type: "message", subtype: "message_changed", channel_type: "im", user: "U1", channel: "D00001", ts: "6.6" })), env, ctx());
    expect(turns).toHaveLength(1);
  });

  it("acks a retry without answering it again", async () => {
    const { env, turns } = await setup();
    const r = await worker.fetch(await signed("/slack/events", event({ type: "app_mention", user: "U1", text: "x", channel: "C00001", ts: "7.7" }), SHARED_SECRET, { "x-slack-retry-num": "1" }), env, ctx());
    expect(r.headers.get("x-slack-no-retry")).toBe("1");
    expect(turns).toHaveLength(0);
  });

  it("verifies a BYO app with its own secret and routes to its bot", async () => {
    const { env, repo, vault, turns } = await setup();
    const tok = await vault.put(ORG, "slack_bot_token", "xoxb-byo");
    const sec = await vault.put(ORG, "slack_signing_secret", BYO_SECRET);
    await repo.upsertInstallation({ apiAppId: "ABYO0001", teamId: "T00001", orgId: ORG, enterpriseId: null, teamName: "Acme", mode: "byo", projectId: PRJ, botUserId: "UBYO", botTokenSecretId: tok, signingSecretId: sec, scopes: "" });
    const body = event({ type: "app_mention", user: "U1", text: "<@UBYO> hi", channel: "C55555", ts: "8.8" }, "ABYO0001");
    expect((await worker.fetch(await signed("/slack/events", body, SHARED_SECRET), env, ctx())).status).toBe(401);
    expect((await worker.fetch(await signed("/slack/events", body, BYO_SECRET), env, ctx())).status).toBe(200);
    expect(turns[0]).toMatchObject({ projectId: PRJ, apiAppId: "ABYO0001", botUserId: "UBYO" });
  });

  it("wipes the installation's token on app_uninstalled", async () => {
    const { env, repo } = await setup();
    const c = ctx();
    await worker.fetch(await signed("/slack/events", event({ type: "app_uninstalled" })), env, c);
    await Promise.all(c.pending);
    const inst = await repo.getInstallation("ASHARED1", "T00001");
    expect(inst).toMatchObject({ status: "revoked", botTokenSecretId: null });
  });

  it("starts a thread for /agent <bot> <question>", async () => {
    const { env, turns } = await setup();
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true, ts: "9.9" }));
    try {
      const form = new URLSearchParams({ api_app_id: "ASHARED1", team_id: "T00001", channel_id: "C00001", user_id: "U1", text: "ops what is the status?" }).toString();
      const c = ctx();
      const r = await worker.fetch(await signed("/slack/commands", form, SHARED_SECRET, {}, "application/x-www-form-urlencoded"), env, c);
      expect(((await r.json()) as any).text).toContain("On it");
      await Promise.all(c.pending);
      expect(turns[0]).toMatchObject({ projectId: PRJ, threadTs: "9.9", text: "what is the status?" });
      const unknown = new URLSearchParams({ api_app_id: "ASHARED1", team_id: "T00001", channel_id: "C00001", user_id: "U1", text: "nope hi" }).toString();
      const r2 = await worker.fetch(await signed("/slack/commands", unknown, SHARED_SECRET, {}, "application/x-www-form-urlencoded"), env, ctx());
      expect(((await r2.json()) as any).text).toContain('No bot called "nope"');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  describe("authenticated routes", () => {
    const authed = (method: string, path: string, body?: unknown) =>
      new Request(`https://gw.internal${path}`, {
        method,
        headers: { "x-actor-subject-id": "usr_00000000000040008000000000000009", "x-actor-subject-type": "user", "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const org = `/v1/organizations/org_${hex(ORG)}`;

    it("lists installations without tokens and builds an install URL with signed state", async () => {
      const { env } = await setup();
      const list = (await (await worker.fetch(authed("GET", `${org}/slack/installations`), env, ctx())).json()) as any;
      expect(list.data[0]).toMatchObject({ teamId: "T00001", mode: "shared", status: "active" });
      expect(JSON.stringify(list)).not.toContain("xoxb");
      const r = (await (await worker.fetch(authed("POST", `${org}/slack/install-url`, {}), env, ctx())).json()) as any;
      const url = new URL(r.data.url);
      expect(url.host).toBe("slack.com");
      expect(url.searchParams.get("scope")).toContain("chat:write.customize");
      expect(url.searchParams.get("redirect_uri")).toBe("https://gw.test/slack/oauth/callback");
      expect((await verifyState("state-secret", url.searchParams.get("state")!))!.orgId).toBe(ORG);
    });

    it("registers a BYO app's installation, encrypted, and refuses another org's app", async () => {
      const { env, repo, db } = await setup();
      const r = await worker.fetch(authed("POST", `${org}/slack/installations`, { apiAppId: "ABYO0002", teamId: "T00001", botToken: "xoxb-abc", signingSecret: "s3", projectId: `prj_${hex(PRJ)}` }), env, ctx());
      expect(r.status).toBe(201);
      const inst = await repo.getInstallation("ABYO0002", "T00001");
      expect(inst).toMatchObject({ mode: "byo", projectId: PRJ });
      const raw = db.prepare("SELECT ciphertext FROM vault_secrets").all() as { ciphertext: string }[];
      expect(raw.some((x) => x.ciphertext.includes("xoxb-abc"))).toBe(false);
      await repo.upsertInstallation({ ...inst!, apiAppId: "AOTHER01", orgId: OTHER });
      const taken = await worker.fetch(authed("POST", `${org}/slack/installations`, { apiAppId: "AOTHER01", teamId: "T00001", botToken: "xoxb-x" }), env, ctx());
      expect(taken.status).toBe(409);
    });

    it("replaces a bot's bindings, refusing unconnected workspaces and taken channels", async () => {
      const { env } = await setup();
      const path = `${org}/projects/prj_${hex(PRJ)}/slack/bindings`;
      let r = await worker.fetch(authed("PUT", path, { bindings: [{ teamId: "T99999", channelId: "C00002", trigger: "mention" }] }), env, ctx());
      expect(r.status).toBe(422);
      r = await worker.fetch(authed("PUT", path, { bindings: [{ teamId: "T00001", channelId: "C00002", trigger: "mention", env: "stage" }] }), env, ctx());
      expect(r.status).toBe(200);
      const got = (await (await worker.fetch(authed("GET", path), env, ctx())).json()) as any;
      expect(got.data).toEqual([{ teamId: "T00001", channelId: "C00002", env: "stage", trigger: "mention", commandSlug: null }]);
    });
  });

  it("signs and verifies OAuth state, refusing tampering", async () => {
    const s = await signState("k", { orgId: ORG, actor: "usr_1", returnTo: null });
    expect((await verifyState("k", s))!.orgId).toBe(ORG);
    expect(await verifyState("other", s)).toBeNull();
    expect(await verifyState("k", s.replace(/^./, "x"))).toBeNull();
  });

  it("serves the shared app's manifest", async () => {
    const { env } = await setup();
    const m = (await (await worker.fetch(new Request("https://gw.test/slack/manifest.json"), env, ctx())).json()) as any;
    expect(m.settings.event_subscriptions.request_url).toBe("https://gw.test/slack/events");
    expect(m.oauth_config.scopes.bot).toContain("app_mentions:read");
  });
});
