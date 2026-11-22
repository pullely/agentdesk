import type { SqlExecutor, SqlRow } from "../d1/executor.js";
import { executeBatch } from "../d1/executor.js";

// The agents bounded context's repository (migration 200_agents_foundation).
// Every read and write is scoped by org_id; nothing here returns a secret's
// ciphertext except the vault reads, which only the vault module calls.

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string" || v === "") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

// ── Vault ──────────────────────────────────────────────────

export interface OrgKeyRow {
  orgId: string;
  dekWrapped: string;
  dekIv: string;
  kekVersion: number;
}

export type SecretPurpose = "llm_key" | "slack_bot_token" | "slack_signing_secret" | "mcp_token" | "mcp_oauth" | "tool_key";

export interface SecretRow {
  id: string;
  orgId: string;
  purpose: SecretPurpose;
  ciphertext: string;
  iv: string;
}

// ── Model keys ─────────────────────────────────────────────

export type ModelKeyProvider = "openai" | "anthropic" | "google" | "openai-compatible" | "exa";

export interface ModelKey {
  id: string;
  orgId: string;
  provider: ModelKeyProvider;
  label: string;
  baseUrl: string | null;
  secretId: string;
  last4: string;
  status: "unverified" | "valid" | "invalid";
  lastVerifiedAt: string | null;
  createdAt: string;
}

function mapModelKey(r: SqlRow): ModelKey {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    provider: r.provider as ModelKeyProvider,
    label: String(r.label),
    baseUrl: str(r.base_url),
    secretId: String(r.secret_id),
    last4: String(r.last4),
    status: r.status as ModelKey["status"],
    lastVerifiedAt: str(r.last_verified_at),
    createdAt: String(r.created_at),
  };
}

// ── Bots ───────────────────────────────────────────────────

export interface BotProfile {
  projectId: string;
  orgId: string;
  displayName: string;
  description: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BotParams {
  temperature?: number;
  maxSteps?: number;
  maxOutputTokens?: number;
}

export interface BotConfigVersion {
  id: string;
  orgId: string;
  projectId: string;
  version: number;
  status: "draft" | "published" | "superseded";
  systemPrompt: string;
  modelRef: string;
  providerKeyId: string | null;
  params: BotParams;
  toolGrants: GrantRow[];
  policyRef: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

function mapProfile(r: SqlRow): BotProfile {
  return {
    projectId: String(r.project_id),
    orgId: String(r.org_id),
    displayName: String(r.display_name),
    description: str(r.description),
    avatarUrl: str(r.avatar_url),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapVersion(r: SqlRow): BotConfigVersion {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    projectId: String(r.project_id),
    version: Number(r.version),
    status: r.status as BotConfigVersion["status"],
    systemPrompt: String(r.system_prompt ?? ""),
    modelRef: String(r.model_ref),
    providerKeyId: str(r.provider_key_id),
    params: json<BotParams>(r.params_json, {}),
    toolGrants: json<GrantRow[]>(r.tool_grants_json, []),
    policyRef: String(r.policy_ref),
    createdBy: str(r.created_by),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    publishedAt: str(r.published_at),
  };
}

export interface DraftInput {
  systemPrompt?: string;
  modelRef?: string;
  providerKeyId?: string | null;
  params?: BotParams;
}

// ── Slack ──────────────────────────────────────────────────

export interface SlackInstallation {
  apiAppId: string;
  teamId: string;
  orgId: string;
  enterpriseId: string | null;
  teamName: string | null;
  mode: "shared" | "byo";
  projectId: string | null;
  botUserId: string | null;
  botTokenSecretId: string | null;
  signingSecretId: string | null;
  scopes: string | null;
  status: "active" | "revoked";
  createdAt: string;
}

function mapInstallation(r: SqlRow): SlackInstallation {
  return {
    apiAppId: String(r.api_app_id),
    teamId: String(r.team_id),
    orgId: String(r.org_id),
    enterpriseId: str(r.enterprise_id),
    teamName: str(r.team_name),
    mode: r.mode as SlackInstallation["mode"],
    projectId: str(r.project_id),
    botUserId: str(r.bot_user_id),
    botTokenSecretId: str(r.bot_token_secret_id),
    signingSecretId: str(r.signing_secret_id),
    scopes: str(r.scopes),
    status: r.status as SlackInstallation["status"],
    createdAt: String(r.created_at),
  };
}

export type BindingTrigger = "mention" | "all" | "command" | "dm";

export interface SlackBinding {
  id: string;
  orgId: string;
  teamId: string;
  channelId: string;
  projectId: string;
  env: "stage" | "prod";
  trigger: BindingTrigger;
  commandSlug: string | null;
}

function mapBinding(r: SqlRow): SlackBinding {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    teamId: String(r.team_id),
    channelId: String(r.channel_id ?? ""),
    projectId: String(r.project_id),
    env: r.env as SlackBinding["env"],
    trigger: r.trigger as BindingTrigger,
    commandSlug: str(r.command_slug),
  };
}

// ── Connectors ─────────────────────────────────────────────

export interface CachedTool {
  name: string;
  description: string;
  inputSchema: unknown;
  descriptionHash: string;
}

export interface ConnectorServer {
  id: string;
  orgId: string;
  name: string;
  url: string;
  transport: "streamable-http" | "sse";
  authType: "none" | "bearer" | "oauth" | "user-oauth";
  secretId: string | null;
  status: "active" | "error" | "disabled";
  tools: CachedTool[];
  toolsSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

function mapServer(r: SqlRow): ConnectorServer {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    name: String(r.name),
    url: String(r.url),
    transport: r.transport as ConnectorServer["transport"],
    authType: r.auth_type as ConnectorServer["authType"],
    secretId: str(r.secret_id),
    status: r.status as ConnectorServer["status"],
    tools: json<CachedTool[]>(r.tools_cache_json, []),
    toolsSyncedAt: str(r.tools_synced_at),
    lastError: str(r.last_error),
    createdAt: String(r.created_at),
  };
}

export interface GrantRow {
  serverId: string;
  toolName: string;
  mode: "allow" | "approve" | "deny";
  argConstraints?: Record<string, string> | null;
  descriptionHash?: string | null;
}

function mapGrant(r: SqlRow): GrantRow {
  return {
    serverId: String(r.server_id),
    toolName: String(r.tool_name),
    mode: r.mode as GrantRow["mode"],
    argConstraints: json<Record<string, string> | null>(r.arg_constraints_json, null),
    descriptionHash: str(r.description_hash),
  };
}

// ── Runs ───────────────────────────────────────────────────

export interface AgentRun {
  id: string;
  orgId: string;
  projectId: string;
  configVersionId: string | null;
  env: string;
  source: "slack" | "playground" | "api";
  teamId: string | null;
  channelId: string | null;
  threadTs: string | null;
  slackUserId: string | null;
  model: string | null;
  status: "running" | "completed" | "failed" | "suspended";
  tokensIn: number;
  tokensOut: number;
  costMicros: number;
  latencyMs: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface AgentRunStep {
  seq: number;
  kind: "llm" | "tool" | "approval";
  tool: string | null;
  policyDecision: "allow" | "deny" | "approve" | null;
  durationMs: number | null;
  io: unknown;
}

function mapRun(r: SqlRow): AgentRun {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    projectId: String(r.project_id),
    configVersionId: str(r.config_version_id),
    env: String(r.env),
    source: r.source as AgentRun["source"],
    teamId: str(r.team_id),
    channelId: str(r.channel_id),
    threadTs: str(r.thread_ts),
    slackUserId: str(r.slack_user_id),
    model: str(r.model),
    status: r.status as AgentRun["status"],
    tokensIn: Number(r.tokens_in ?? 0),
    tokensOut: Number(r.tokens_out ?? 0),
    costMicros: Number(r.cost_micros ?? 0),
    latencyMs: r.latency_ms === null || r.latency_ms === undefined ? null : Number(r.latency_ms),
    error: str(r.error),
    startedAt: String(r.started_at),
    finishedAt: str(r.finished_at),
  };
}

export interface StartRunInput {
  orgId: string;
  projectId: string;
  configVersionId: string | null;
  env: string;
  source: AgentRun["source"];
  teamId?: string | null;
  channelId?: string | null;
  threadTs?: string | null;
  slackUserId?: string | null;
  model?: string | null;
}

export interface FinishRunInput {
  status: "completed" | "failed" | "suspended";
  tokensIn: number;
  tokensOut: number;
  costMicros?: number;
  latencyMs: number;
  error?: string | null;
  steps: Omit<AgentRunStep, "seq">[];
}

export function createAgentsRepository(db: SqlExecutor) {
  return {
    // ── projects (the baseline's; a bot is a project) ──────
    async projectInOrg(orgId: string, projectId: string): Promise<{ id: string; name: string; slug: string } | null> {
      const { rows } = await db.execute(`SELECT id, name, slug FROM projects_projects WHERE org_id = $1 AND id = $2 AND status = 'active'`, [orgId, projectId]);
      const r = rows[0];
      return r ? { id: String(r.id), name: String(r.name), slug: String(r.slug) } : null;
    },

    // ── vault rows ─────────────────────────────────────────
    async getOrgKey(orgId: string): Promise<OrgKeyRow | null> {
      const { rows } = await db.execute(`SELECT org_id, dek_wrapped, dek_iv, kek_version FROM vault_org_keys WHERE org_id = $1`, [orgId]);
      const r = rows[0];
      return r ? { orgId: String(r.org_id), dekWrapped: String(r.dek_wrapped), dekIv: String(r.dek_iv), kekVersion: Number(r.kek_version) } : null;
    },
    /** Insert-if-absent; returns the row that won (a concurrent writer may). */
    async insertOrgKey(row: OrgKeyRow): Promise<OrgKeyRow> {
      await db.execute(
        `INSERT INTO vault_org_keys (org_id, dek_wrapped, dek_iv, kek_version) VALUES ($1, $2, $3, $4) ON CONFLICT (org_id) DO NOTHING`,
        [row.orgId, row.dekWrapped, row.dekIv, row.kekVersion],
      );
      return (await this.getOrgKey(row.orgId)) ?? row;
    },
    async insertSecret(row: Omit<SecretRow, "id">): Promise<string> {
      const id = uuid();
      await db.execute(`INSERT INTO vault_secrets (id, org_id, purpose, ciphertext, iv) VALUES ($1, $2, $3, $4, $5)`, [
        id,
        row.orgId,
        row.purpose,
        row.ciphertext,
        row.iv,
      ]);
      return id;
    },
    async getSecret(orgId: string, id: string): Promise<SecretRow | null> {
      const { rows } = await db.execute(`SELECT id, org_id, purpose, ciphertext, iv FROM vault_secrets WHERE org_id = $1 AND id = $2`, [orgId, id]);
      const r = rows[0];
      return r
        ? { id: String(r.id), orgId: String(r.org_id), purpose: r.purpose as SecretPurpose, ciphertext: String(r.ciphertext), iv: String(r.iv) }
        : null;
    },
    async deleteSecret(orgId: string, id: string): Promise<void> {
      await db.execute(`DELETE FROM vault_secrets WHERE org_id = $1 AND id = $2`, [orgId, id]);
    },

    // ── model keys ─────────────────────────────────────────
    async listModelKeys(orgId: string): Promise<ModelKey[]> {
      const { rows } = await db.execute(`SELECT * FROM llm_provider_keys WHERE org_id = $1 ORDER BY created_at DESC, id DESC`, [orgId]);
      return rows.map(mapModelKey);
    },
    async getModelKey(orgId: string, id: string): Promise<ModelKey | null> {
      const { rows } = await db.execute(`SELECT * FROM llm_provider_keys WHERE org_id = $1 AND id = $2`, [orgId, id]);
      return rows[0] ? mapModelKey(rows[0]) : null;
    },
    async insertModelKey(input: Omit<ModelKey, "id" | "createdAt" | "lastVerifiedAt"> & { createdBy?: string | null; lastVerifiedAt?: string | null }): Promise<ModelKey> {
      const id = uuid();
      await db.execute(
        `INSERT INTO llm_provider_keys (id, org_id, provider, label, base_url, secret_id, last4, status, last_verified_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, input.orgId, input.provider, input.label, input.baseUrl, input.secretId, input.last4, input.status, input.lastVerifiedAt ?? null, input.createdBy ?? null],
      );
      return (await this.getModelKey(input.orgId, id))!;
    },
    async setModelKeyStatus(orgId: string, id: string, status: ModelKey["status"]): Promise<void> {
      await db.execute(`UPDATE llm_provider_keys SET status = $3, last_verified_at = $4, updated_at = $4 WHERE org_id = $1 AND id = $2`, [orgId, id, status, now()]);
    },
    async deleteModelKey(orgId: string, id: string): Promise<ModelKey | null> {
      const key = await this.getModelKey(orgId, id);
      if (!key) return null;
      await executeBatch(db, [
        { text: `DELETE FROM llm_provider_keys WHERE org_id = $1 AND id = $2`, params: [orgId, id] },
        { text: `DELETE FROM vault_secrets WHERE org_id = $1 AND id = $2`, params: [orgId, key.secretId] },
      ]);
      return key;
    },

    // ── bots ───────────────────────────────────────────────
    async listProfiles(orgId: string): Promise<BotProfile[]> {
      const { rows } = await db.execute(`SELECT * FROM bots_profiles WHERE org_id = $1 ORDER BY created_at DESC`, [orgId]);
      return rows.map(mapProfile);
    },
    async getProfile(orgId: string, projectId: string): Promise<BotProfile | null> {
      const { rows } = await db.execute(`SELECT * FROM bots_profiles WHERE org_id = $1 AND project_id = $2`, [orgId, projectId]);
      return rows[0] ? mapProfile(rows[0]) : null;
    },
    async upsertProfile(input: { orgId: string; projectId: string; displayName: string; description?: string | null; avatarUrl?: string | null }): Promise<BotProfile> {
      const t = now();
      await db.execute(
        `INSERT INTO bots_profiles (project_id, org_id, display_name, description, avatar_url, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (project_id) DO UPDATE SET display_name = excluded.display_name, description = excluded.description,
           avatar_url = excluded.avatar_url, updated_at = excluded.updated_at
         WHERE bots_profiles.org_id = excluded.org_id`,
        [input.projectId, input.orgId, input.displayName, input.description ?? null, input.avatarUrl ?? null, t],
      );
      return (await this.getProfile(input.orgId, input.projectId))!;
    },
    async listVersions(orgId: string, projectId: string): Promise<BotConfigVersion[]> {
      const { rows } = await db.execute(`SELECT * FROM bots_config_versions WHERE org_id = $1 AND project_id = $2 ORDER BY version DESC`, [orgId, projectId]);
      return rows.map(mapVersion);
    },
    async getVersionByStatus(orgId: string, projectId: string, status: "draft" | "published"): Promise<BotConfigVersion | null> {
      const { rows } = await db.execute(`SELECT * FROM bots_config_versions WHERE org_id = $1 AND project_id = $2 AND status = $3`, [orgId, projectId, status]);
      return rows[0] ? mapVersion(rows[0]) : null;
    },
    async getVersion(orgId: string, id: string): Promise<BotConfigVersion | null> {
      const { rows } = await db.execute(`SELECT * FROM bots_config_versions WHERE org_id = $1 AND id = $2`, [orgId, id]);
      return rows[0] ? mapVersion(rows[0]) : null;
    },
    /** The draft, created from the published version (or defaults) when there is none. */
    async ensureDraft(orgId: string, projectId: string, createdBy: string | null): Promise<BotConfigVersion> {
      const existing = await this.getVersionByStatus(orgId, projectId, "draft");
      if (existing) return existing;
      const published = await this.getVersionByStatus(orgId, projectId, "published");
      const { rows } = await db.execute(`SELECT COALESCE(MAX(version), 0) AS v FROM bots_config_versions WHERE project_id = $1`, [projectId]);
      const next = Number(rows[0]?.v ?? 0) + 1;
      const id = uuid();
      await db.execute(
        `INSERT INTO bots_config_versions (id, org_id, project_id, version, status, system_prompt, model_ref, provider_key_id, params_json, policy_ref, created_by)
         VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
        [
          id,
          orgId,
          projectId,
          next,
          published?.systemPrompt ?? "",
          published?.modelRef ?? "workers-ai:@cf/moonshotai/kimi-k2.6",
          published?.providerKeyId ?? null,
          JSON.stringify(published?.params ?? { temperature: 0.3, maxSteps: 8 }),
          published?.policyRef ?? "builtin:v1",
          createdBy,
        ],
      );
      return (await this.getVersionByStatus(orgId, projectId, "draft"))!;
    },
    async updateDraft(orgId: string, projectId: string, input: DraftInput, actor: string | null): Promise<BotConfigVersion> {
      const draft = await this.ensureDraft(orgId, projectId, actor);
      const merged = {
        systemPrompt: input.systemPrompt ?? draft.systemPrompt,
        modelRef: input.modelRef ?? draft.modelRef,
        providerKeyId: input.providerKeyId === undefined ? draft.providerKeyId : input.providerKeyId,
        params: { ...draft.params, ...(input.params ?? {}) },
      };
      await db.execute(
        `UPDATE bots_config_versions SET system_prompt = $3, model_ref = $4, provider_key_id = $5, params_json = $6, updated_at = $7
         WHERE org_id = $1 AND id = $2 AND status = 'draft'`,
        [orgId, draft.id, merged.systemPrompt, merged.modelRef, merged.providerKeyId, JSON.stringify(merged.params), now()],
      );
      return (await this.getVersion(orgId, draft.id))!;
    },
    /**
     * Publish the draft: the published version becomes superseded, the draft
     * becomes published with a snapshot of the grants — one atomic batch.
     */
    async publishDraft(orgId: string, projectId: string, grants: GrantRow[]): Promise<BotConfigVersion | null> {
      const draft = await this.getVersionByStatus(orgId, projectId, "draft");
      if (!draft) return null;
      const t = now();
      await executeBatch(db, [
        {
          text: `UPDATE bots_config_versions SET status = 'superseded', updated_at = $3 WHERE org_id = $1 AND project_id = $2 AND status = 'published'`,
          params: [orgId, projectId, t],
        },
        {
          text: `UPDATE bots_config_versions SET status = 'published', tool_grants_json = $3, published_at = $4, updated_at = $4 WHERE org_id = $1 AND id = $2 AND status = 'draft'`,
          params: [orgId, draft.id, JSON.stringify(grants), t],
        },
      ]);
      return this.getVersion(orgId, draft.id);
    },

    // ── slack ──────────────────────────────────────────────
    async upsertInstallation(i: Omit<SlackInstallation, "createdAt" | "status"> & { installedBy?: string | null }): Promise<SlackInstallation> {
      await db.execute(
        `INSERT INTO slack_installations (api_app_id, team_id, org_id, enterprise_id, team_name, mode, project_id, bot_user_id, bot_token_secret_id, signing_secret_id, scopes, status, installed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12)
         ON CONFLICT (api_app_id, team_id) DO UPDATE SET org_id = excluded.org_id, enterprise_id = excluded.enterprise_id, team_name = excluded.team_name,
           mode = excluded.mode, project_id = excluded.project_id, bot_user_id = excluded.bot_user_id, bot_token_secret_id = excluded.bot_token_secret_id,
           signing_secret_id = excluded.signing_secret_id, scopes = excluded.scopes, status = 'active', updated_at = $13`,
        [i.apiAppId, i.teamId, i.orgId, i.enterpriseId, i.teamName, i.mode, i.projectId, i.botUserId, i.botTokenSecretId, i.signingSecretId, i.scopes, i.installedBy ?? null, now()],
      );
      return (await this.getInstallation(i.apiAppId, i.teamId))!;
    },
    /** The gateway's lookup: by app and team, before the org is known. */
    async getInstallation(apiAppId: string, teamId: string): Promise<SlackInstallation | null> {
      const { rows } = await db.execute(`SELECT * FROM slack_installations WHERE api_app_id = $1 AND team_id = $2`, [apiAppId, teamId]);
      return rows[0] ? mapInstallation(rows[0]) : null;
    },
    async listInstallations(orgId: string): Promise<SlackInstallation[]> {
      const { rows } = await db.execute(`SELECT * FROM slack_installations WHERE org_id = $1 ORDER BY created_at DESC`, [orgId]);
      return rows.map(mapInstallation);
    },
    async revokeInstallation(apiAppId: string, teamId: string): Promise<SlackInstallation | null> {
      const inst = await this.getInstallation(apiAppId, teamId);
      if (!inst) return null;
      const statements: { text: string; params: unknown[] }[] = [
        {
          text: `UPDATE slack_installations SET status = 'revoked', bot_token_secret_id = NULL, updated_at = $3 WHERE api_app_id = $1 AND team_id = $2`,
          params: [apiAppId, teamId, now()],
        },
      ];
      if (inst.botTokenSecretId) {
        statements.push({ text: `DELETE FROM vault_secrets WHERE org_id = $1 AND id = $2`, params: [inst.orgId, inst.botTokenSecretId] });
      }
      await executeBatch(db, statements);
      return inst;
    },
    async listBindings(orgId: string, projectId?: string): Promise<SlackBinding[]> {
      const { rows } = projectId
        ? await db.execute(`SELECT * FROM slack_bindings WHERE org_id = $1 AND project_id = $2 ORDER BY created_at`, [orgId, projectId])
        : await db.execute(`SELECT * FROM slack_bindings WHERE org_id = $1 ORDER BY created_at`, [orgId]);
      return rows.map(mapBinding);
    },
    async replaceBindings(
      orgId: string,
      projectId: string,
      bindings: Omit<SlackBinding, "id" | "orgId" | "projectId">[],
    ): Promise<SlackBinding[]> {
      await executeBatch(db, [
        { text: `DELETE FROM slack_bindings WHERE org_id = $1 AND project_id = $2`, params: [orgId, projectId] },
        ...bindings.map((b) => ({
          text: `INSERT INTO slack_bindings (id, org_id, team_id, channel_id, project_id, env, trigger, command_slug) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          params: [uuid(), orgId, b.teamId, b.channelId ?? "", projectId, b.env, b.trigger, b.commandSlug ?? null],
        })),
      ]);
      return this.listBindings(orgId, projectId);
    },
    /** Which bot answers here: an exact channel binding first, then the team's DM binding. */
    async resolveBinding(orgId: string, teamId: string, channelId: string, trigger: BindingTrigger): Promise<SlackBinding | null> {
      const { rows } = await db.execute(
        `SELECT * FROM slack_bindings WHERE org_id = $1 AND team_id = $2 AND channel_id = $3 AND trigger IN ($4, 'all') ORDER BY CASE trigger WHEN $4 THEN 0 ELSE 1 END LIMIT 1`,
        [orgId, teamId, channelId, trigger],
      );
      return rows[0] ? mapBinding(rows[0]) : null;
    },
    async resolveCommand(orgId: string, teamId: string, slug: string): Promise<SlackBinding | null> {
      const { rows } = await db.execute(`SELECT * FROM slack_bindings WHERE org_id = $1 AND team_id = $2 AND command_slug = $3 LIMIT 1`, [orgId, teamId, slug]);
      return rows[0] ? mapBinding(rows[0]) : null;
    },

    // ── connectors ─────────────────────────────────────────
    async listServers(orgId: string): Promise<ConnectorServer[]> {
      const { rows } = await db.execute(`SELECT * FROM connectors_servers WHERE org_id = $1 ORDER BY created_at DESC, id DESC`, [orgId]);
      return rows.map(mapServer);
    },
    async getServer(orgId: string, id: string): Promise<ConnectorServer | null> {
      const { rows } = await db.execute(`SELECT * FROM connectors_servers WHERE org_id = $1 AND id = $2`, [orgId, id]);
      return rows[0] ? mapServer(rows[0]) : null;
    },
    async insertServer(s: { orgId: string; name: string; url: string; transport: ConnectorServer["transport"]; authType: ConnectorServer["authType"]; secretId: string | null; createdBy?: string | null }): Promise<ConnectorServer> {
      const id = uuid();
      await db.execute(
        `INSERT INTO connectors_servers (id, org_id, name, url, transport, auth_type, secret_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, s.orgId, s.name, s.url, s.transport, s.authType, s.secretId, s.createdBy ?? null],
      );
      return (await this.getServer(s.orgId, id))!;
    },
    async updateServerTools(orgId: string, id: string, result: { tools: CachedTool[] } | { error: string }): Promise<void> {
      const t = now();
      if ("error" in result) {
        await db.execute(`UPDATE connectors_servers SET status = 'error', last_error = $3, updated_at = $4 WHERE org_id = $1 AND id = $2`, [orgId, id, result.error.slice(0, 500), t]);
      } else {
        await db.execute(
          `UPDATE connectors_servers SET status = 'active', last_error = NULL, tools_cache_json = $3, tools_synced_at = $4, updated_at = $4 WHERE org_id = $1 AND id = $2`,
          [orgId, id, JSON.stringify(result.tools), t],
        );
      }
    },
    async deleteServer(orgId: string, id: string): Promise<ConnectorServer | null> {
      const s = await this.getServer(orgId, id);
      if (!s) return null;
      const statements: { text: string; params: unknown[] }[] = [
        { text: `DELETE FROM connectors_grants WHERE org_id = $1 AND server_id = $2`, params: [orgId, id] },
        { text: `DELETE FROM connectors_servers WHERE org_id = $1 AND id = $2`, params: [orgId, id] },
      ];
      if (s.secretId) statements.push({ text: `DELETE FROM vault_secrets WHERE org_id = $1 AND id = $2`, params: [orgId, s.secretId] });
      await executeBatch(db, statements);
      return s;
    },
    async listGrants(orgId: string, projectId: string): Promise<GrantRow[]> {
      const { rows } = await db.execute(`SELECT * FROM connectors_grants WHERE org_id = $1 AND project_id = $2 ORDER BY server_id, tool_name`, [orgId, projectId]);
      return rows.map(mapGrant);
    },
    async replaceGrants(orgId: string, projectId: string, grants: GrantRow[], actor: string | null): Promise<GrantRow[]> {
      await executeBatch(db, [
        { text: `DELETE FROM connectors_grants WHERE org_id = $1 AND project_id = $2`, params: [orgId, projectId] },
        ...grants.map((g) => ({
          text: `INSERT INTO connectors_grants (id, org_id, project_id, server_id, tool_name, mode, arg_constraints_json, description_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          params: [uuid(), orgId, projectId, g.serverId, g.toolName, g.mode, g.argConstraints ? JSON.stringify(g.argConstraints) : null, g.descriptionHash ?? null, actor],
        })),
      ]);
      return this.listGrants(orgId, projectId);
    },

    // ── runs ───────────────────────────────────────────────
    async startRun(input: StartRunInput): Promise<string> {
      const id = uuid();
      await db.execute(
        `INSERT INTO agent_runs (id, org_id, project_id, config_version_id, env, source, team_id, channel_id, thread_ts, slack_user_id, model, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'running')`,
        [id, input.orgId, input.projectId, input.configVersionId, input.env, input.source, input.teamId ?? null, input.channelId ?? null, input.threadTs ?? null, input.slackUserId ?? null, input.model ?? null],
      );
      return id;
    },
    async finishRun(orgId: string, runId: string, input: FinishRunInput): Promise<void> {
      const t = now();
      await executeBatch(db, [
        {
          text: `UPDATE agent_runs SET status = $3, tokens_in = $4, tokens_out = $5, cost_micros = $6, latency_ms = $7, error = $8, finished_at = $9 WHERE org_id = $1 AND id = $2`,
          params: [orgId, runId, input.status, input.tokensIn, input.tokensOut, input.costMicros ?? 0, input.latencyMs, input.error ?? null, t],
        },
        ...input.steps.slice(0, 200).map((s, i) => ({
          text: `INSERT INTO agent_run_steps (run_id, seq, org_id, kind, tool, policy_decision, duration_ms, redacted_io_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          params: [runId, i + 1, orgId, s.kind, s.tool ?? null, s.policyDecision ?? null, s.durationMs ?? null, s.io === undefined ? null : JSON.stringify(s.io)],
        })),
      ]);
    },
    async listRuns(orgId: string, projectId: string, opts: { limit?: number; before?: string } = {}): Promise<AgentRun[]> {
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
      const { rows } = opts.before
        ? await db.execute(
            `SELECT * FROM agent_runs WHERE org_id = $1 AND project_id = $2 AND started_at < $3 ORDER BY started_at DESC, id DESC LIMIT $4`,
            [orgId, projectId, opts.before, limit],
          )
        : await db.execute(`SELECT * FROM agent_runs WHERE org_id = $1 AND project_id = $2 ORDER BY started_at DESC, id DESC LIMIT $3`, [orgId, projectId, limit]);
      return rows.map(mapRun);
    },
    async getRun(orgId: string, runId: string): Promise<(AgentRun & { steps: AgentRunStep[] }) | null> {
      const { rows } = await db.execute(`SELECT * FROM agent_runs WHERE org_id = $1 AND id = $2`, [orgId, runId]);
      if (!rows[0]) return null;
      const steps = await db.execute(`SELECT * FROM agent_run_steps WHERE org_id = $1 AND run_id = $2 ORDER BY seq`, [orgId, runId]);
      return {
        ...mapRun(rows[0]),
        steps: steps.rows.map((s) => ({
          seq: Number(s.seq),
          kind: s.kind as AgentRunStep["kind"],
          tool: str(s.tool),
          policyDecision: (s.policy_decision as AgentRunStep["policyDecision"]) ?? null,
          durationMs: s.duration_ms === null ? null : Number(s.duration_ms),
          io: json<unknown>(s.redacted_io_json, null),
        })),
      };
    },
    async countRunsSince(orgId: string, since: string): Promise<number> {
      const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM agent_runs WHERE org_id = $1 AND started_at >= $2`, [orgId, since]);
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export type AgentsRepository = ReturnType<typeof createAgentsRepository>;
