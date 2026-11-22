// agentdesk (agentdesk-agent-bots): the wire types of the bot platform —
// bots-worker, config-worker's model keys, connectors-worker, slack-gateway-
// worker and the runs the runtime records. Ids are public ids:
// prj_ (bot = project), bcv_ (config version), lpk_ (model key),
// mcs_ (MCP server), run_ (run).

export type ModelKeyProvider = "openai" | "anthropic" | "google" | "openai-compatible" | "exa";

export interface ModelKey {
  id: string;
  provider: ModelKeyProvider;
  label: string;
  baseUrl: string | null;
  last4: string;
  status: "unverified" | "valid" | "invalid";
  lastVerifiedAt: string | null;
  createdAt: string;
}

export interface CreateModelKeyRequest {
  provider: ModelKeyProvider;
  label?: string;
  /** Posted once, never returned. */
  key: string;
  baseUrl?: string;
}

export interface BotProfile {
  projectId: string;
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

export type GrantMode = "allow" | "approve" | "deny";

export interface ToolGrant {
  /** An MCP server id (mcs_…), or "builtin". */
  serverId: string;
  /** A tool name, or "*". */
  toolName: string;
  mode: GrantMode;
  argConstraints?: Record<string, string> | null;
}

export interface BotConfigVersion {
  id: string;
  version: number;
  status: "draft" | "published" | "superseded";
  systemPrompt: string;
  modelRef: string;
  providerKeyId: string | null;
  params: BotParams;
  toolGrants: ToolGrant[];
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface Bot {
  profile: BotProfile | null;
  draft: BotConfigVersion | null;
  published: BotConfigVersion | null;
}

export interface UpdateDraftRequest {
  systemPrompt?: string;
  modelRef?: string;
  providerKeyId?: string | null;
  params?: BotParams;
}

export interface PlaygroundRequest {
  messages: { role: "user" | "assistant"; content: string }[];
}

export interface RunStep {
  seq: number;
  kind: "llm" | "tool" | "approval";
  tool: string | null;
  policyDecision: "allow" | "deny" | "approve" | null;
  durationMs: number | null;
  io: unknown;
}

export interface AgentRun {
  id: string;
  projectId: string;
  configVersionId: string | null;
  env: string;
  source: "slack" | "playground" | "api";
  channelId: string | null;
  threadTs: string | null;
  model: string | null;
  status: "running" | "completed" | "failed" | "suspended";
  tokensIn: number;
  tokensOut: number;
  latencyMs: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  steps?: RunStep[];
}

export interface PlaygroundResponse {
  reply: string;
  run: AgentRun;
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  transport: "streamable-http" | "sse";
  authType: "none" | "bearer" | "oauth" | "user-oauth";
  status: "active" | "error" | "disabled";
  tools: { name: string; description: string }[];
  toolsSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface CreateMcpServerRequest {
  name: string;
  url: string;
  authType: "none" | "bearer";
  /** For bearer: posted once, never returned. */
  token?: string;
}

export interface SlackInstallation {
  teamId: string;
  teamName: string | null;
  mode: "shared" | "byo";
  botUserId: string | null;
  status: "active" | "revoked";
  createdAt: string;
}

export interface SlackBinding {
  teamId: string;
  /** "" = the bot's DMs. */
  channelId: string;
  env: "stage" | "prod";
  trigger: "mention" | "all" | "command" | "dm";
  commandSlug: string | null;
}
