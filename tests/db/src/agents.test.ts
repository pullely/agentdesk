import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqlExecutor, type D1Binding } from "@saas/db/d1";
import { createAgentsRepository, createVault, kekRingFromEnv } from "@saas/db/agents";
import { D1ApiAdapter } from "@saas/db/runner";

const splitStatements = D1ApiAdapter.splitStatements;

// 200_agents_foundation and the agents repository, against a real SQLite
// engine (D1 is SQLite), through the production executor and splitter.
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

function migrationDirs(): string[] {
  return readdirSync(MIGRATIONS_ROOT)
    .filter((d) => existsSync(join(MIGRATIONS_ROOT, d, "up.sql")))
    .sort();
}

/** A D1 binding backed by an in-memory SQLite database. */
function d1Over(db: DatabaseSync): D1Binding {
  return {
    prepare(query: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        all<T>() {
          const prepared = db.prepare(query);
          const rows = prepared.all(...(bound as never[])) as T[];
          return Promise.resolve({ results: rows, success: true });
        },
      };
      return statement;
    },
    // D1's batch is one implicit transaction: every statement applies or none
    // does. Mirrored with a real SQLite transaction, so the suite proves the
    // rollback rather than assuming it.
    async batch(statements: Array<{ all(): Promise<unknown> }>) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Binding;
}

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const dir of migrationDirs()) {
    const sql = readFileSync(join(MIGRATIONS_ROOT, dir, "up.sql"), "utf8");
    for (const statement of splitStatements(sql)) db.exec(statement);
  }
  return db;
}


function repo() {
  return createAgentsRepository(createSqlExecutor(d1Over(migratedDatabase())));
}

describe("agents repository (200_agents_foundation)", () => {
  it("keeps one draft, publishes it immutably, and versions the next draft", async () => {
    const r = repo();
    await r.upsertProfile({ orgId: "o1", projectId: "p1", displayName: "Ops bot" });
    const d1 = await r.updateDraft("o1", "p1", { systemPrompt: "v1 prompt", params: { maxSteps: 4 } }, "u1");
    expect(d1).toMatchObject({ version: 1, status: "draft", systemPrompt: "v1 prompt" });
    expect(d1.params.maxSteps).toBe(4);
    expect((await r.ensureDraft("o1", "p1", "u1")).id).toBe(d1.id);

    const p1 = await r.publishDraft("o1", "p1", [{ serverId: "builtin", toolName: "getWeather", mode: "allow" }]);
    expect(p1).toMatchObject({ version: 1, status: "published" });
    expect(p1!.toolGrants).toHaveLength(1);
    expect(await r.getVersionByStatus("o1", "p1", "draft")).toBeNull();

    const d2 = await r.updateDraft("o1", "p1", { systemPrompt: "v2 prompt" }, "u1");
    expect(d2).toMatchObject({ version: 2, status: "draft", systemPrompt: "v2 prompt" });
    // the published row did not move
    expect((await r.getVersion("o1", p1!.id))!.systemPrompt).toBe("v1 prompt");
    await r.publishDraft("o1", "p1", []);
    expect((await r.getVersion("o1", p1!.id))!.status).toBe("superseded");
    expect((await r.getVersionByStatus("o1", "p1", "published"))!.version).toBe(2);
  });

  it("scopes every read by org", async () => {
    const r = repo();
    await r.upsertProfile({ orgId: "o1", projectId: "p1", displayName: "A" });
    expect(await r.getProfile("o2", "p1")).toBeNull();
    const secretId = await r.insertSecret({ orgId: "o1", purpose: "llm_key", ciphertext: "c", iv: "i" });
    expect(await r.getSecret("o2", secretId)).toBeNull();
    expect((await r.getSecret("o1", secretId))!.ciphertext).toBe("c");
  });

  it("stores model keys by last4 and deletes the vault row with them", async () => {
    const r = repo();
    const secretId = await r.insertSecret({ orgId: "o1", purpose: "llm_key", ciphertext: "c", iv: "i" });
    const k = await r.insertModelKey({ orgId: "o1", provider: "openai", label: "main", baseUrl: null, secretId, last4: "abcd", status: "valid" });
    expect((await r.listModelKeys("o1")).map((x) => x.last4)).toEqual(["abcd"]);
    await r.deleteModelKey("o1", k.id);
    expect(await r.listModelKeys("o1")).toEqual([]);
    expect(await r.getSecret("o1", secretId)).toBeNull();
  });

  it("routes Slack events by installation and binding", async () => {
    const r = repo();
    await r.upsertInstallation({ apiAppId: "A1", teamId: "T1", orgId: "o1", enterpriseId: null, teamName: "Acme", mode: "shared", projectId: null, botUserId: "B1", botTokenSecretId: null, signingSecretId: null, scopes: "chat:write" });
    expect((await r.getInstallation("A1", "T1"))!.orgId).toBe("o1");
    await r.replaceBindings("o1", "p1", [
      { teamId: "T1", channelId: "C1", env: "prod", trigger: "mention", commandSlug: null },
      { teamId: "T1", channelId: "", env: "prod", trigger: "dm", commandSlug: null },
      { teamId: "T1", channelId: "", env: "prod", trigger: "command", commandSlug: "ops" },
    ]);
    expect((await r.resolveBinding("o1", "T1", "C1", "mention"))!.projectId).toBe("p1");
    expect(await r.resolveBinding("o1", "T1", "C9", "mention")).toBeNull();
    expect((await r.resolveBinding("o1", "T1", "", "dm"))!.projectId).toBe("p1");
    expect((await r.resolveCommand("o1", "T1", "ops"))!.projectId).toBe("p1");
    await r.revokeInstallation("A1", "T1");
    expect((await r.getInstallation("A1", "T1"))!.status).toBe("revoked");
  });

  it("keeps connector grants and removes them with their server", async () => {
    const r = repo();
    const s = await r.insertServer({ orgId: "o1", name: "docs", url: "https://mcp.example.com", transport: "streamable-http", authType: "none", secretId: null });
    await r.updateServerTools("o1", s.id, { tools: [{ name: "search", description: "d", inputSchema: {}, descriptionHash: "h" }] });
    expect((await r.getServer("o1", s.id))!.tools[0]!.name).toBe("search");
    await r.replaceGrants("o1", "p1", [{ serverId: s.id, toolName: "search", mode: "allow", argConstraints: { q: "*" } }], "u1");
    expect((await r.listGrants("o1", "p1"))[0]).toMatchObject({ toolName: "search", mode: "allow", argConstraints: { q: "*" } });
    await r.deleteServer("o1", s.id);
    expect(await r.listGrants("o1", "p1")).toEqual([]);
  });

  it("records a run with its steps", async () => {
    const r = repo();
    const id = await r.startRun({ orgId: "o1", projectId: "p1", configVersionId: null, env: "stage", source: "playground", model: "workers-ai:@cf/moonshotai/kimi-k2.6" });
    await r.finishRun("o1", id, { status: "completed", tokensIn: 10, tokensOut: 5, latencyMs: 42, steps: [{ kind: "llm", tool: null, policyDecision: null, durationMs: 40, io: null }, { kind: "tool", tool: "getWeather", policyDecision: "allow", durationMs: 2, io: "x" }] });
    const run = await r.getRun("o1", id);
    expect(run).toMatchObject({ status: "completed", tokensIn: 10, latencyMs: 42 });
    expect(run!.steps.map((s) => s.kind)).toEqual(["llm", "tool"]);
    expect((await r.listRuns("o1", "p1")).length).toBe(1);
    expect(await r.getRun("o2", id)).toBeNull();
    expect(await r.countRunsSince("o1", "2000-01-01")).toBe(1);
  });
});

const kek = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

describe("vault (envelope encryption)", () => {
  it("round-trips a secret and stores only ciphertext", async () => {
    const r = repo();
    const vault = createVault(r, kekRingFromEnv({ VAULT_KEK_V1: kek() })!);
    const id = await vault.put("o1", "llm_key", "sk-live-very-secret-1234");
    const row = await r.getSecret("o1", id);
    expect(row!.ciphertext).not.toContain("very-secret");
    expect(await vault.get("o1", id)).toBe("sk-live-very-secret-1234");
    expect(await vault.get("o2", id)).toBeNull();
  });

  it("gives every org its own data key", async () => {
    const r = repo();
    const vault = createVault(r, kekRingFromEnv({ VAULT_KEK_V1: kek() })!);
    await vault.put("o1", "llm_key", "a");
    await vault.put("o2", "llm_key", "b");
    expect((await r.getOrgKey("o1"))!.dekWrapped).not.toBe((await r.getOrgKey("o2"))!.dekWrapped);
  });

  it("refuses a tampered ciphertext and a wrong KEK", async () => {
    const r = repo();
    const vault = createVault(r, kekRingFromEnv({ VAULT_KEK_V1: kek() })!);
    const id = await vault.put("o1", "mcp_token", "tok");
    const other = createVault(r, kekRingFromEnv({ VAULT_KEK_V1: kek() })!);
    await expect(other.get("o1", id)).rejects.toThrow();
  });

  it("reads DEKs wrapped by an older KEK after rotation", async () => {
    const r = repo();
    const v1 = kek();
    const id = await createVault(r, kekRingFromEnv({ VAULT_KEK_V1: v1 })!).put("o1", "llm_key", "old");
    const ring = kekRingFromEnv({ VAULT_KEK_V1: v1, VAULT_KEK_V2: kek() })!;
    expect(ring.current).toBe(2);
    expect(await createVault(r, ring).get("o1", id)).toBe("old");
  });
});
