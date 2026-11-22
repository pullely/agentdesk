import type {
  AgentRun,
  Bot,
  BotConfigVersion,
  BotProfile,
  CreateMcpServerRequest,
  CreateModelKeyRequest,
  McpServer,
  ModelKey,
  PlaygroundRequest,
  PlaygroundResponse,
  SlackBinding,
  SlackInstallation,
  ToolGrant,
  UpdateDraftRequest,
} from "@saas/contracts/agents";

import type { RequestOptions, Transport } from "./transport.js";

const o = (orgId: string) => `/v1/organizations/${encodeURIComponent(orgId)}`;
const p = (orgId: string, projectId: string) => `${o(orgId)}/projects/${encodeURIComponent(projectId)}`;

/**
 * agentdesk's bot platform: bots (one per project), model keys, MCP
 * connectors, Slack installations and bindings, runs. Backed by bots-worker,
 * config-worker, connectors-worker and slack-gateway-worker through
 * api-edge's agents facade.
 */
export class AgentsClient {
  constructor(private readonly transport: Transport) {}

  // ── bots ──────────────────────────────────────────────────
  listBots(orgId: string, opts: RequestOptions = {}) {
    return this.transport.request<BotProfile[]>({ method: "GET", path: `${o(orgId)}/bots` }, opts);
  }
  getBot(orgId: string, projectId: string, opts: RequestOptions = {}) {
    return this.transport.request<Bot>({ method: "GET", path: `${p(orgId, projectId)}/bot` }, opts);
  }
  updateProfile(orgId: string, projectId: string, body: { displayName?: string; description?: string; avatarUrl?: string }, opts: RequestOptions = {}) {
    return this.transport.request<BotProfile>({ method: "PUT", path: `${p(orgId, projectId)}/bot`, body }, opts);
  }
  listVersions(orgId: string, projectId: string, opts: RequestOptions = {}) {
    return this.transport.request<BotConfigVersion[]>({ method: "GET", path: `${p(orgId, projectId)}/bot/versions` }, opts);
  }
  updateDraft(orgId: string, projectId: string, body: UpdateDraftRequest, opts: RequestOptions = {}) {
    return this.transport.request<BotConfigVersion>({ method: "PUT", path: `${p(orgId, projectId)}/bot/draft`, body }, opts);
  }
  publish(orgId: string, projectId: string, opts: RequestOptions = {}) {
    return this.transport.request<BotConfigVersion>({ method: "POST", path: `${p(orgId, projectId)}/bot/publish` }, opts);
  }
  playground(orgId: string, projectId: string, body: PlaygroundRequest, opts: RequestOptions = {}) {
    return this.transport.request<PlaygroundResponse>({ method: "POST", path: `${p(orgId, projectId)}/bot/playground`, body }, opts);
  }
  listGrants(orgId: string, projectId: string, opts: RequestOptions = {}) {
    return this.transport.request<ToolGrant[]>({ method: "GET", path: `${p(orgId, projectId)}/grants` }, opts);
  }
  replaceGrants(orgId: string, projectId: string, grants: ToolGrant[], opts: RequestOptions = {}) {
    return this.transport.request<ToolGrant[]>({ method: "PUT", path: `${p(orgId, projectId)}/grants`, body: { grants } }, opts);
  }
  listRuns(orgId: string, projectId: string, query: { limit?: number; before?: string } = {}, opts: RequestOptions = {}) {
    return this.transport.request<AgentRun[]>(
      { method: "GET", path: `${p(orgId, projectId)}/runs`, query: { ...(query.limit ? { limit: String(query.limit) } : {}), ...(query.before ? { before: query.before } : {}) } },
      opts,
    );
  }
  getRun(orgId: string, runId: string, opts: RequestOptions = {}) {
    return this.transport.request<AgentRun>({ method: "GET", path: `${o(orgId)}/runs/${encodeURIComponent(runId)}` }, opts);
  }

  // ── model keys ────────────────────────────────────────────
  listModelKeys(orgId: string, opts: RequestOptions = {}) {
    return this.transport.request<ModelKey[]>({ method: "GET", path: `${o(orgId)}/model-keys` }, opts);
  }
  addModelKey(orgId: string, body: CreateModelKeyRequest, opts: RequestOptions = {}) {
    return this.transport.request<ModelKey>({ method: "POST", path: `${o(orgId)}/model-keys`, body }, opts);
  }
  verifyModelKey(orgId: string, keyId: string, opts: RequestOptions = {}) {
    return this.transport.request<ModelKey>({ method: "POST", path: `${o(orgId)}/model-keys/${encodeURIComponent(keyId)}/verify` }, opts);
  }
  removeModelKey(orgId: string, keyId: string, opts: RequestOptions = {}) {
    return this.transport.request<{ id: string; deleted: boolean }>({ method: "DELETE", path: `${o(orgId)}/model-keys/${encodeURIComponent(keyId)}` }, opts);
  }

  // ── connectors ────────────────────────────────────────────
  listConnectors(orgId: string, opts: RequestOptions = {}) {
    return this.transport.request<McpServer[]>({ method: "GET", path: `${o(orgId)}/connectors` }, opts);
  }
  addConnector(orgId: string, body: CreateMcpServerRequest, opts: RequestOptions = {}) {
    return this.transport.request<McpServer>({ method: "POST", path: `${o(orgId)}/connectors`, body }, opts);
  }
  syncConnector(orgId: string, serverId: string, opts: RequestOptions = {}) {
    return this.transport.request<McpServer & { changedTools: string[] }>({ method: "POST", path: `${o(orgId)}/connectors/${encodeURIComponent(serverId)}/sync` }, opts);
  }
  removeConnector(orgId: string, serverId: string, opts: RequestOptions = {}) {
    return this.transport.request<{ id: string; deleted: boolean }>({ method: "DELETE", path: `${o(orgId)}/connectors/${encodeURIComponent(serverId)}` }, opts);
  }

  // ── slack ─────────────────────────────────────────────────
  listSlackInstallations(orgId: string, opts: RequestOptions = {}) {
    return this.transport.request<SlackInstallation[]>({ method: "GET", path: `${o(orgId)}/slack/installations` }, opts);
  }
  slackInstallUrl(orgId: string, returnTo?: string, opts: RequestOptions = {}) {
    return this.transport.request<{ url: string }>({ method: "POST", path: `${o(orgId)}/slack/install-url`, body: returnTo ? { returnTo } : {} }, opts);
  }
  registerSlackApp(orgId: string, body: { apiAppId: string; teamId: string; teamName?: string; botToken: string; signingSecret?: string; botUserId?: string; projectId?: string }, opts: RequestOptions = {}) {
    return this.transport.request<SlackInstallation>({ method: "POST", path: `${o(orgId)}/slack/installations`, body }, opts);
  }
  removeSlackInstallation(orgId: string, teamId: string, opts: RequestOptions = {}) {
    return this.transport.request<{ teamId: string; revoked: number }>({ method: "DELETE", path: `${o(orgId)}/slack/installations/${encodeURIComponent(teamId)}` }, opts);
  }
  listBindings(orgId: string, projectId: string, opts: RequestOptions = {}) {
    return this.transport.request<SlackBinding[]>({ method: "GET", path: `${p(orgId, projectId)}/slack/bindings` }, opts);
  }
  replaceBindings(orgId: string, projectId: string, bindings: SlackBinding[], opts: RequestOptions = {}) {
    return this.transport.request<SlackBinding[]>({ method: "PUT", path: `${p(orgId, projectId)}/slack/bindings`, body: { bindings } }, opts);
  }
}
