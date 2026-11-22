import { jest } from "@jest/globals";
import type { DatabaseSync } from "node:sqlite";
import worker from "@agent-runtime-worker/index";
import { ThreadAgent, threadName, type SlackTurn } from "@agent-runtime-worker/thread-agent";
import { compileGrants } from "@agent-runtime-worker/engine";
import type { Env } from "@agent-runtime-worker/env";
import { createAgentsRepository, createVault, kekRingFromEnv } from "@saas/db/agents";
import { createSqlExecutor } from "@saas/db/d1";
import { d1Over, migratedDatabase } from "./sqlite-d1";
import { fakeAI } from "./fake-ai";
import { fakeState } from "./fake-do";

// agentdesk AD-4: the runtime, end to end under Node — the real AI SDK, the
// real workers-ai-provider over a fake AI binding, the real compiled OPA
// policy, the real just-bash sandbox, a real SQLite D1, and ThreadAgent on a
// node:sqlite-backed Durable Object state.

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const PRJ = "cccccccc-0000-4000-8000-000000000003";
const KEK = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");

async function setup(opts: { grants?: { serverId: string; toolName: string; mode: "allow" | "approve" | "deny" }[]; publish?: boolean } = {}) {
  const db: DatabaseSync = migratedDatabase();
  db.prepare("INSERT INTO projects_projects (id, org_id, name, slug, slug_lower) VALUES (?, ?, ?, ?, ?)").run(PRJ, ORG, "Ops bot", "ops", "ops");
  const repo = createAgentsRepository(createSqlExecutor(d1Over(db) as never));
  await repo.upsertProfile({ orgId: ORG, projectId: PRJ, displayName: "Ops", avatarUrl: "https://example.com/ops.png" });
  await repo.updateDraft(ORG, PRJ, { systemPrompt: "You are {{bot_name}}.", params: { maxSteps: 4 } }, null);
  await repo.replaceGrants(ORG, PRJ, opts.grants ?? [{ serverId: "builtin", toolName: "bash", mode: "allow" }], null);
  if (opts.publish) await repo.publishDraft(ORG, PRJ, await repo.listGrants(ORG, PRJ));
  const ai = fakeAI();
  const env: Env = { ENVIRONMENT: "stage", PLATFORM_DB: d1Over(db) as unknown as D1Database, AI: ai as unknown as Ai, VAULT_KEK_V1: KEK, SLACK_API_URL: "https://slack.test/api/" };
  return { db, repo, ai, env };
}

const post = (env: Env, path: string, body: unknown) =>
  worker.fetch(new Request(`https://agent-runtime.internal${path}`, { method: "POST", body: JSON.stringify(body) }), env);

describe("compileGrants", () => {
  it("expands a built-in wildcard and keeps MCP grants for the MCP layer", () => {
    const { grants, builtinGranted, mcpGrants } = compileGrants([
      { serverId: "builtin", toolName: "*", mode: "allow" },
      { serverId: "builtin", toolName: "writeFile", mode: "deny" },
      { serverId: "s1", toolName: "search", mode: "allow" },
    ]);
    expect(builtinGranted).toEqual(expect.arrayContaining(["bash", "getWeather", "readFile"]));
    expect(grants.writeFile).toEqual({ mode: "deny" });
    expect(mcpGrants).toHaveLength(1);
  });
});

describe("playground (POST /internal/playground)", () => {
  it("answers on the draft config through Workers AI and records the run", async () => {
    const { env, ai, db } = await setup();
    const res = await post(env, "/internal/playground", { orgId: ORG, projectId: PRJ, messages: [{ role: "user", content: "hello" }] });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;
    expect(data.run.error ?? null).toBeNull();
    expect(data.reply).toContain("Echo: hello");
    expect(data.reply).toContain("🔧 none");
    expect(data.run).toMatchObject({ status: "completed", model: "workers-ai:@cf/moonshotai/kimi-k2.6" });
    expect(ai.calls[0]!.model).toBe("@cf/moonshotai/kimi-k2.6");
    expect(ai.calls[0]!.tools).toEqual(["bash"]);
    const usage = db.prepare("SELECT metric, quantity FROM metering_usage_records WHERE org_id = ? ORDER BY metric").all(ORG) as { metric: string }[];
    expect(usage.map((u) => u.metric)).toEqual(expect.arrayContaining(["agent_runs", "agent_tokens_in", "agent_tokens_out"]));
  });

  it("runs a granted bash command the policy allows", async () => {
    const { env } = await setup();
    const res = await post(env, "/internal/playground", { orgId: ORG, projectId: PRJ, messages: [{ role: "user", content: "please run `ls`" }] });
    const { data } = (await res.json()) as any;
    expect(data.reply).toContain("Tool said:");
    expect(data.reply).toContain("🔧 bash");
    expect(data.run.steps.some((s: any) => s.kind === "tool" && s.tool === "bash" && s.policyDecision === "allow")).toBe(true);
  });

  it("refuses a command the ported policy denies", async () => {
    const { env } = await setup();
    const res = await post(env, "/internal/playground", { orgId: ORG, projectId: PRJ, messages: [{ role: "user", content: "run `rm -rf notes.txt`" }] });
    const { data } = (await res.json()) as any;
    expect(data.reply).toContain("`rm` is not an allowed command");
    expect(data.reply).toContain("bash (blocked by policy)");
  });

  it("offers no tools to a bot with no grants", async () => {
    const { env, ai } = await setup({ grants: [] });
    await post(env, "/internal/playground", { orgId: ORG, projectId: PRJ, messages: [{ role: "user", content: "run `ls`" }] });
    expect(ai.calls[0]!.tools).toEqual([]);
  });

  it("records a failed run when a BYOK key is missing", async () => {
    const { env, repo } = await setup();
    await repo.updateDraft(ORG, PRJ, { modelRef: "openai:gpt-4o" }, null);
    const res = await post(env, "/internal/playground", { orgId: ORG, projectId: PRJ, messages: [{ role: "user", content: "hi" }] });
    const { data } = (await res.json()) as any;
    expect(data.run.status).toBe("failed");
    expect(data.run.error).toContain("model key");
  });

  it("validates the body and answers health", async () => {
    const { env } = await setup();
    expect((await post(env, "/internal/playground", { orgId: ORG })).status).toBe(422);
    const h = await worker.fetch(new Request("https://x/health"), env);
    expect(((await h.json()) as any).data).toMatchObject({ status: "ok", environment: "stage", vault: true });
  });
});

describe("ThreadAgent", () => {
  let slackCalls: { method: string; body: any }[];
  let fetchSpy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    slackCalls = [];
    let ts = 1000;
    fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.startsWith("https://slack.test/api/")) return new Response("{}", { status: 404 });
      const method = url.slice("https://slack.test/api/".length);
      const raw = String(init?.body ?? "");
      const body = raw.startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
      slackCalls.push({ method, body });
      if (method === "chat.postMessage") return Response.json({ ok: true, ts: String(++ts) });
      if (method === "conversations.replies") return Response.json({ ok: true, messages: [{ user: "U1", text: "<@B1> earlier question", ts: "1.0" }] });
      return Response.json({ ok: true });
    });
  });
  afterEach(() => fetchSpy.mockRestore());

  async function agentFor(env: Env, repo: ReturnType<typeof createAgentsRepository>) {
    const tokenId = await createVault(repo, kekRingFromEnv({ VAULT_KEK_V1: KEK })!).put(ORG, "slack_bot_token", "xoxb-test-token");
    const { state } = fakeState();
    const agent = new ThreadAgent(state as never, env);
    await new Promise((r) => setTimeout(r, 0));
    const turn = (text: string, eventTs: string, threadTs = "1.0"): SlackTurn => ({
      orgId: ORG, projectId: PRJ, env: "prod", apiAppId: "A1", teamId: "T1", channelId: "C1", threadTs, eventTs,
      slackUserId: "U1", text, botUserId: "B1", botTokenSecretId: tokenId,
    });
    return { agent, state, turn };
  }

  it("queues turns, dedupes event ids, and answers in order on the published config", async () => {
    const { env, repo } = await setup({ publish: true });
    const { agent, turn } = await agentFor(env, repo);
    const r1 = await agent.fetch(new Request("https://t/turn", { method: "POST", body: JSON.stringify(turn("<@B1> first", "2.0")) }));
    expect(r1.status).toBe(202);
    const dup = await agent.fetch(new Request("https://t/turn", { method: "POST", body: JSON.stringify(turn("<@B1> first", "2.0")) }));
    expect(((await dup.json()) as any).data.duplicate).toBe(true);
    await agent.fetch(new Request("https://t/turn", { method: "POST", body: JSON.stringify(turn("<@B1> second", "3.0")) }));
    await agent.alarm();

    // Cold start read the thread once; then a placeholder and a final edit per turn.
    expect(slackCalls.filter((c) => c.method === "conversations.replies")).toHaveLength(1);
    const posts = slackCalls.filter((c) => c.method === "chat.postMessage");
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).toMatchObject({ channel: "C1", thread_ts: "1.0", username: "Ops", icon_url: "https://example.com/ops.png" });
    const finals = slackCalls.filter((c) => c.method === "chat.update").map((c) => c.body.text);
    expect(finals.some((t) => t.includes("Echo: first"))).toBe(true);
    expect(finals[finals.length - 1]).toContain("Echo: second");

    const state = await (await agent.fetch(new Request("https://t/state"))).json() as any;
    expect(state.data.pending).toBe(0);
    expect(state.data.messages).toBe(5); // earlier question + 2 × (user, assistant)
    expect(state.data.pinnedVersion).toBeTruthy();
  });

  it("keeps the version a thread started on after a new publish", async () => {
    const { env, repo } = await setup({ publish: true });
    const { agent, turn } = await agentFor(env, repo);
    await agent.fetch(new Request("https://t/turn", { method: "POST", body: JSON.stringify(turn("<@B1> one", "2.0", "2.0")) }));
    await agent.alarm();
    const pinned = ((await (await agent.fetch(new Request("https://t/state"))).json()) as any).data.pinnedVersion;
    await repo.updateDraft(ORG, PRJ, { systemPrompt: "v2" }, null);
    await repo.publishDraft(ORG, PRJ, []);
    await agent.fetch(new Request("https://t/turn", { method: "POST", body: JSON.stringify(turn("<@B1> two", "3.0", "2.0")) }));
    await agent.alarm();
    const runs = await repo.listRuns(ORG, PRJ);
    expect(runs.every((r) => r.configVersionId === pinned)).toBe(true);
  });

  it("says so when the bot has never been published", async () => {
    const { env, repo } = await setup({ publish: false });
    const { agent, turn } = await agentFor(env, repo);
    await agent.fetch(new Request("https://t/turn", { method: "POST", body: JSON.stringify(turn("<@B1> hi", "2.0", "2.0")) }));
    await agent.alarm();
    expect(slackCalls.find((c) => c.method === "chat.postMessage")!.body.text).toContain("no published configuration");
  });

  it("names threads by tenant", () => {
    expect(threadName({ orgId: "o", projectId: "p", teamId: "T", channelId: "C", threadTs: "1.2" })).toBe("o:p:T:C:1.2");
  });
});
