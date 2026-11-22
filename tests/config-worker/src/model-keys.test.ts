import { jest } from "@jest/globals";
import { route } from "@config-worker/router";
import type { Env } from "@config-worker/env";
import { createAgentsRepository } from "@saas/db/agents";
import { createSqlExecutor } from "@saas/db/d1";
import { d1Over, migratedDatabase } from "./sqlite-d1";

// agentdesk AD-2: BYOK model keys in config-worker's vault.

const ORG_UUID = "11111111-2222-4333-8444-555555555555";
const ORG = `org_${ORG_UUID.replace(/-/g, "")}`;
const KEK = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

function fetcher(body: unknown, status = 200) {
  return { fetch: jest.fn(async () => Response.json({ data: body }, { status })) } as unknown as Fetcher;
}

function setup(opts: { allow?: boolean; kek?: boolean } = {}) {
  const db = migratedDatabase();
  const env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: d1Over(db) as unknown as D1Database,
    MEMBERSHIP_WORKER: fetcher({ memberships: [] }),
    POLICY_WORKER: fetcher({ allow: opts.allow ?? true }),
    ...(opts.kek === false ? {} : { VAULT_KEK_V1: KEK }),
  } as Env;
  return { env, repo: createAgentsRepository(createSqlExecutor(d1Over(db) as never)) };
}

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://config.internal${path}`, {
    method,
    headers: { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

let fetchSpy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    String(input).includes("api.openai.com") ? new Response("{}", { status: 200 }) : new Response("no", { status: 401 }),
  );
});
afterEach(() => fetchSpy.mockRestore());

describe("model keys (AD-2)", () => {
  it("verifies, encrypts and answers with last4 only", async () => {
    const { env, repo } = setup();
    const res = await route(req("POST", `/v1/organizations/${ORG}/model-keys`, { provider: "openai", label: "main", key: "sk-test-abcdefghijkl1234" }), env);
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ provider: "openai", label: "main", last4: "1234", status: "valid" });
    expect(JSON.stringify(data)).not.toContain("abcdefghijkl");
    const [row] = await repo.listModelKeys(ORG_UUID);
    const secret = await repo.getSecret(ORG_UUID, row!.secretId);
    expect(secret!.ciphertext).not.toContain("abcdefghijkl");

    const listed = (await (await route(req("GET", `/v1/organizations/${ORG}/model-keys`), env)).json()) as { data: unknown[] };
    expect(listed.data).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("abcdefghijkl");

    const del = await route(req("DELETE", `/v1/organizations/${ORG}/model-keys/${data.id}`), env);
    expect(del.status).toBe(200);
    expect(await repo.listModelKeys(ORG_UUID)).toEqual([]);
  });

  it("refuses a key the provider rejects", async () => {
    const { env } = setup();
    const res = await route(req("POST", `/v1/organizations/${ORG}/model-keys`, { provider: "anthropic", key: "sk-ant-bad-key-0000" }), env);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("model_key_invalid");
  });

  it("validates the body", async () => {
    const { env } = setup();
    const res = await route(req("POST", `/v1/organizations/${ORG}/model-keys`, { provider: "nope", key: "x" }), env);
    expect(res.status).toBe(422);
  });

  it("hides the route from a member without provider_key.manage", async () => {
    const { env } = setup({ allow: false });
    expect((await route(req("GET", `/v1/organizations/${ORG}/model-keys`), env)).status).toBe(404);
  });

  it("says so when the vault key is missing", async () => {
    const { env } = setup({ kek: false });
    const res = await route(req("POST", `/v1/organizations/${ORG}/model-keys`, { provider: "openai", key: "sk-test-abcdefghijkl1234" }), env);
    expect(res.status).toBe(503);
  });

  it("requires an actor", async () => {
    const { env } = setup();
    const res = await route(new Request(`https://config.internal/v1/organizations/${ORG}/model-keys`), env);
    expect(res.status).toBe(401);
  });
});
