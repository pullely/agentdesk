import { jest } from "@jest/globals";
import type { DatabaseSync } from "node:sqlite";
import { route } from "@bots-worker/router";
import type { Env } from "@bots-worker/env";
import { createAgentsRepository } from "@saas/db/agents";
import { createSqlExecutor } from "@saas/db/d1";
import { d1Over, migratedDatabase } from "./sqlite-d1";

// agentdesk AD-3: bots-worker against a real SQLite D1.

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
const PRJ_A = "cccccccc-0000-4000-8000-000000000003";
const hex = (u: string) => u.replace(/-/g, "");
const org = (u: string) => `org_${hex(u)}`;
const prj = (u: string) => `prj_${hex(u)}`;

function seed(db: DatabaseSync) {
  db.prepare("INSERT INTO projects_projects (id, org_id, name, slug, slug_lower) VALUES (?, ?, ?, ?, ?)").run(PRJ_A, ORG_A, "Ops bot", "ops", "ops");
}

function fetcher(body: unknown, status = 200) {
  return { fetch: jest.fn(async () => Response.json({ data: body }, { status })) } as unknown as Fetcher;
}

function setup(opts: { allow?: boolean | ((action: string) => boolean); runtime?: Fetcher } = {}) {
  const db = migratedDatabase();
  seed(db);
  const decide = typeof opts.allow === "function" ? opts.allow : () => opts.allow ?? true;
  const policy = {
    fetch: jest.fn(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { action: string };
      return Response.json({ data: { allow: decide(body.action) } });
    }),
  } as unknown as Fetcher;
  const env: Env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: d1Over(db) as unknown as D1Database,
    MEMBERSHIP_WORKER: fetcher({ memberships: [] }),
    POLICY_WORKER: policy,
    ...(opts.runtime ? { AGENT_RUNTIME: opts.runtime } : {}),
  };
  return { env, db, repo: createAgentsRepository(createSqlExecutor(d1Over(db) as never)) };
}

const call = async (env: Env, method: string, path: string, body?: unknown) => {
  const res = await route(
    new Request(`https://bots.internal${path}`, {
      method,
      headers: { "x-actor-subject-id": "usr_00000000000040008000000000000009", "x-actor-subject-type": "user", "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
  );
  return { status: res.status, json: (await res.json()) as any };
};

const base = `/v1/organizations/${org(ORG_A)}/projects/${prj(PRJ_A)}`;

describe("bots-worker (AD-3)", () => {
  it("answers health", async () => {
    const { env } = setup();
    const r = await route(new Request("https://bots.internal/health"), env);
    expect(r.status).toBe(200);
  });

  it("drafts, publishes immutably and versions the next draft", async () => {
    const { env } = setup();
    let r = await call(env, "GET", `${base}/bot`);
    expect(r.json.data).toEqual({ profile: null, draft: null, published: null });

    r = await call(env, "PUT", `${base}/bot/draft`, { systemPrompt: "You are {{bot_name}}.", params: { temperature: 0.2, maxSteps: 5 } });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ version: 1, status: "draft", modelRef: "workers-ai:@cf/moonshotai/kimi-k2.6", params: { temperature: 0.2, maxSteps: 5 } });

    r = await call(env, "PUT", `${base}/grants`, { grants: [{ serverId: "builtin", toolName: "getWeather", mode: "allow" }] });
    expect(r.status).toBe(200);

    r = await call(env, "POST", `${base}/bot/publish`);
    expect(r.json.data).toMatchObject({ version: 1, status: "published" });
    expect(r.json.data.toolGrants).toEqual([{ serverId: "builtin", toolName: "getWeather", mode: "allow", argConstraints: null }]);

    r = await call(env, "POST", `${base}/bot/publish`);
    expect(r.status).toBe(409);

    r = await call(env, "PUT", `${base}/bot/draft`, { systemPrompt: "v2" });
    expect(r.json.data).toMatchObject({ version: 2, status: "draft", systemPrompt: "v2" });
    r = await call(env, "GET", `${base}/bot`);
    expect(r.json.data.published.systemPrompt).toBe("You are {{bot_name}}.");
    expect(r.json.data.profile.displayName).toBe("Ops bot");

    r = await call(env, "GET", `${base}/bot/versions`);
    expect(r.json.data.map((v: any) => v.version)).toEqual([2, 1]);
  });

  it("validates the draft", async () => {
    const { env } = setup();
    let r = await call(env, "PUT", `${base}/bot/draft`, { modelRef: "workers-ai:@cf/unknown" });
    expect(r.status).toBe(422);
    r = await call(env, "PUT", `${base}/bot/draft`, { modelRef: "openai:gpt-4o" });
    expect(r.json.error.details.fields.providerKeyId).toBeDefined();
    r = await call(env, "PUT", `${base}/bot/draft`, { params: { maxSteps: 99 } });
    expect(r.status).toBe(422);
    r = await call(env, "PUT", `${base}/bot/draft`, { modelRef: "openai:gpt-4o", providerKeyId: "lpk_00000000000040008000000000000000" });
    expect(r.json.error.details.fields.providerKeyId[0]).toContain("not a model key");
  });

  it("takes a BYOK key that belongs to the org", async () => {
    const { env, repo } = setup();
    const secretId = await repo.insertSecret({ orgId: ORG_A, purpose: "llm_key", ciphertext: "c", iv: "i" });
    const key = await repo.insertModelKey({ orgId: ORG_A, provider: "openai", label: "k", baseUrl: null, secretId, last4: "1234", status: "valid" });
    const r = await call(env, "PUT", `${base}/bot/draft`, { modelRef: "openai:gpt-4o", providerKeyId: `lpk_${hex(key.id)}` });
    expect(r.status).toBe(200);
    expect(r.json.data.providerKeyId).toBe(`lpk_${hex(key.id)}`);
  });

  it("validates grants against built-ins and the org's synced MCP tools", async () => {
    const { env, repo } = setup();
    let r = await call(env, "PUT", `${base}/grants`, { grants: [{ serverId: "builtin", toolName: "rm", mode: "allow" }] });
    expect(r.status).toBe(422);
    const s = await repo.insertServer({ orgId: ORG_A, name: "docs", url: "https://mcp.example.com", transport: "streamable-http", authType: "none", secretId: null });
    await repo.updateServerTools(ORG_A, s.id, { tools: [{ name: "search", description: "d", inputSchema: {}, descriptionHash: "h1" }] });
    r = await call(env, "PUT", `${base}/grants`, { grants: [{ serverId: `mcs_${hex(s.id)}`, toolName: "nope", mode: "allow" }] });
    expect(r.json.error.details.fields.grants[0]).toContain("sync it first");
    r = await call(env, "PUT", `${base}/grants`, { grants: [{ serverId: `mcs_${hex(s.id)}`, toolName: "search", mode: "allow", argConstraints: { q: "acme*" } }] });
    expect(r.status).toBe(200);
    expect((await repo.listGrants(ORG_A, PRJ_A))[0]!.descriptionHash).toBe("h1");
  });

  it("hides another org's project and denies by policy as not found", async () => {
    const { env } = setup();
    let r = await call(env, "GET", `/v1/organizations/${org(ORG_B)}/projects/${prj(PRJ_A)}/bot`);
    expect(r.status).toBe(404);
    const denied = setup({ allow: (a) => a !== "bot.publish" });
    await call(denied.env, "PUT", `${base}/bot/draft`, { systemPrompt: "x" });
    r = await call(denied.env, "POST", `${base}/bot/publish`);
    expect(r.status).toBe(404);
  });

  it("relays the playground to agent-runtime, or says it is not there", async () => {
    const { env } = setup();
    let r = await call(env, "POST", `${base}/bot/playground`, { messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("runtime_unavailable");
    const runtime = { fetch: jest.fn(async () => Response.json({ data: { reply: "hello" } })) } as unknown as Fetcher;
    const withRuntime = setup({ runtime });
    r = await call(withRuntime.env, "POST", `${base}/bot/playground`, { messages: [{ role: "user", content: "hi" }] });
    expect(r.json.data.reply).toBe("hello");
    const init = ((runtime.fetch as jest.Mock).mock.calls[0] as unknown[])[1] as RequestInit;
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({ orgId: ORG_A, projectId: PRJ_A });
    r = await call(withRuntime.env, "POST", `${base}/bot/playground`, { messages: [{ role: "system", content: "x" }] });
    expect(r.status).toBe(422);
  });

  it("lists runs and reads one with its steps, scoped to the org", async () => {
    const { env, repo } = setup();
    const id = await repo.startRun({ orgId: ORG_A, projectId: PRJ_A, configVersionId: null, env: "stage", source: "playground" });
    await repo.finishRun(ORG_A, id, { status: "completed", tokensIn: 3, tokensOut: 2, latencyMs: 10, steps: [{ kind: "llm", tool: null, policyDecision: null, durationMs: 9, io: null }] });
    let r = await call(env, "GET", `${base}/runs`);
    expect(r.json.data).toHaveLength(1);
    r = await call(env, "GET", `/v1/organizations/${org(ORG_A)}/runs/run_${hex(id)}`);
    expect(r.json.data).toMatchObject({ status: "completed", tokensIn: 3 });
    expect(r.json.data.steps).toHaveLength(1);
    r = await call(env, "GET", `/v1/organizations/${org(ORG_B)}/runs/run_${hex(id)}`);
    expect(r.status).toBe(404);
  });

  it("writes an audit event per change", async () => {
    const { env, db } = setup();
    await call(env, "PUT", `${base}/bot/draft`, { systemPrompt: "x" });
    await call(env, "POST", `${base}/bot/publish`);
    const rows = db.prepare("SELECT type FROM events_event_log WHERE org_id = ? ORDER BY occurred_at").all(ORG_A) as { type: string }[];
    expect(rows.map((r) => r.type)).toEqual(expect.arrayContaining(["bot.config.updated", "bot.published"]));
  });

  it("requires an actor", async () => {
    const { env } = setup();
    expect((await route(new Request(`https://bots.internal${base}/bot`), env)).status).toBe(401);
  });
});
