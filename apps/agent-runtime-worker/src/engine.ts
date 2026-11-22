import type { ModelMessage, ToolSet } from "ai";
import {
  BUILTIN_SERVER_ID,
  BUILTIN_TOOL_NAMES,
  buildSystemPrompt,
  builtinTools,
  exaSearch,
  formatReply,
  mcpToolName,
  resolveModel,
  runAgent,
  type Grants,
  type RunStep,
} from "@saas/agent-core";
import {
  createAgentsRepository,
  createVault,
  kekRingFromEnv,
  type AgentsRepository,
  type BotConfigVersion,
  type GrantRow,
} from "@saas/db/agents";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/d1";
import { createMeteringRepository } from "@saas/db/metering";
import { recordAudit } from "@saas/worker-kit";
import type { Env } from "./env.js";
import { mcpToolsFor } from "./mcp.js";

// THE TURN ENGINE — shared by the ThreadAgent (Slack) and the playground.
// Load the bot's config version, decrypt what it needs from the vault, build
// the granted tool set, run the ported agent loop, and record the run, its
// steps, its usage and an audit event.

export type ConfigChoice = { kind: "draft" } | { kind: "published" } | { kind: "version"; id: string };

export interface LoadedBot {
  version: BotConfigVersion;
  displayName: string;
  avatarUrl: string | null;
  grants: GrantRow[];
}

export async function loadBot(repo: AgentsRepository, orgId: string, projectId: string, choice: ConfigChoice): Promise<LoadedBot | null> {
  let version: BotConfigVersion | null = null;
  if (choice.kind === "version") version = await repo.getVersion(orgId, choice.id);
  else if (choice.kind === "draft") {
    version = (await repo.getVersionByStatus(orgId, projectId, "draft")) ?? (await repo.getVersionByStatus(orgId, projectId, "published"));
  } else version = await repo.getVersionByStatus(orgId, projectId, "published");
  if (!version || version.projectId !== projectId) return null;
  const [profile, project] = await Promise.all([repo.getProfile(orgId, projectId), repo.projectInOrg(orgId, projectId)]);
  // The draft runs on the live grants (what the builder is editing); a
  // published version on the grants snapshotted when it was published.
  const grants = version.status === "draft" ? await repo.listGrants(orgId, projectId) : version.toolGrants;
  return {
    version,
    displayName: profile?.displayName ?? project?.name ?? "agentdesk bot",
    avatarUrl: profile?.avatarUrl ?? null,
    grants,
  };
}

export interface TurnInput {
  orgId: string;
  projectId: string;
  env: string;
  source: "slack" | "playground" | "api";
  messages: ModelMessage[];
  userName?: string | undefined;
  channelName?: string | undefined;
  channelId?: string | undefined;
  teamId?: string | undefined;
  threadTs?: string | undefined;
  slackUserId?: string | undefined;
  onText?: (text: string) => void | Promise<void>;
}

export interface TurnResult {
  runId: string;
  reply: string;
  status: "completed" | "failed";
  error?: string;
  steps: RunStep[];
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  model: string;
}

export function repoFor(env: Env): { db: SqlExecutor; repo: AgentsRepository } {
  if (!env.PLATFORM_DB) throw new Error("PLATFORM_DB is not bound");
  const db = createSqlExecutor(env.PLATFORM_DB);
  return { db, repo: createAgentsRepository(db) };
}

export async function runTurn(env: Env, bot: LoadedBot, input: TurnInput): Promise<TurnResult> {
  const { db, repo } = repoFor(env);
  const started = Date.now();
  const runId = await repo.startRun({
    orgId: input.orgId,
    projectId: input.projectId,
    configVersionId: bot.version.id,
    env: input.env,
    source: input.source,
    teamId: input.teamId ?? null,
    channelId: input.channelId ?? null,
    threadTs: input.threadTs ?? null,
    slackUserId: input.slackUserId ?? null,
    model: bot.version.modelRef,
  });

  let result: TurnResult;
  try {
    const ring = kekRingFromEnv(env as unknown as Record<string, unknown>);
    const vault = ring ? createVault(repo, ring) : null;

    // The model: Workers AI, or the bot's BYOK key decrypted for this call.
    let key = null;
    if (!bot.version.modelRef.startsWith("workers-ai:")) {
      const k = bot.version.providerKeyId ? await repo.getModelKey(input.orgId, bot.version.providerKeyId) : null;
      const value = k && vault ? await vault.get(input.orgId, k.secretId) : null;
      if (!k || !value) throw new Error("the bot's model key is missing or the vault is not configured");
      key = { provider: k.provider as "openai" | "anthropic" | "openai-compatible", apiKey: value, baseUrl: k.baseUrl };
    }
    const model = resolveModel({
      modelRef: bot.version.modelRef,
      ai: env.AI,
      gateway: { ...(env.AI_GATEWAY_ID ? { gatewayId: env.AI_GATEWAY_ID } : {}), ...(key && env.AI_GATEWAY_ID ? await gatewayUrl(env) : {}) },
      key,
      metadata: { org: input.orgId, project: input.projectId, run: runId, env: input.env },
    });

    // The tools: only granted ones reach the model.
    const { grants, builtinGranted, mcpGrants } = compileGrants(bot.grants);
    let searchWeb;
    if (builtinGranted.includes("searchWeb") && vault) {
      const exa = (await repo.listModelKeys(input.orgId)).find((k) => k.provider === "exa" && k.status === "valid");
      const exaKey = exa ? await vault.get(input.orgId, exa.secretId) : null;
      searchWeb = exaSearch(exaKey);
    }
    const tools: ToolSet = {
      ...(await builtinTools({ granted: builtinGranted, ...(searchWeb ? { searchWeb } : {}) })),
      ...(await mcpToolsFor(env, repo, input.orgId, input.projectId, mcpGrants, grants)),
    };

    const system = buildSystemPrompt({
      botPrompt: bot.version.systemPrompt,
      vars: {
        bot_name: bot.displayName,
        ...(input.userName ? { user_name: input.userName } : {}),
        ...(input.channelName ? { channel: input.channelName } : {}),
      },
      toolNames: Object.keys(tools),
    });

    const agent = await runAgent({
      model: model.model,
      system,
      messages: input.messages,
      tools,
      runtimeContext: {
        orgId: input.orgId,
        projectId: input.projectId,
        ...(input.channelId ? { channelId: input.channelId } : {}),
        ...(input.slackUserId ? { userId: input.slackUserId } : {}),
        grants,
      },
      maxSteps: bot.version.params.maxSteps ?? 8,
      ...(bot.version.params.temperature !== undefined ? { temperature: bot.version.params.temperature } : {}),
      ...(bot.version.params.maxOutputTokens !== undefined ? { maxOutputTokens: bot.version.params.maxOutputTokens } : {}),
      ...(input.onText ? { onText: input.onText } : {}),
    });

    result = {
      runId,
      reply: formatReply(agent.text, agent.outcomes),
      status: "completed",
      steps: agent.steps,
      tokensIn: agent.usage.inputTokens,
      tokensOut: agent.usage.outputTokens,
      latencyMs: Date.now() - started,
      model: `${model.provider}:${model.id}`,
    };
  } catch (e) {
    const message = (e as Error).message?.slice(0, 300) || "error";
    result = {
      runId,
      reply: "⚠️ I couldn't answer that — the run failed. An admin can see why in agentdesk (Runs).",
      status: "failed",
      error: message,
      steps: [],
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: Date.now() - started,
      model: bot.version.modelRef,
    };
  }

  await repo.finishRun(input.orgId, runId, {
    status: result.status,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    latencyMs: result.latencyMs,
    error: result.error ?? null,
    steps: result.steps.map((s) => ({
      kind: s.kind,
      tool: s.tool ?? null,
      policyDecision: s.policyDecision ?? null,
      durationMs: s.durationMs,
      io: s.io ?? null,
    })),
  });
  await meter(db, input, runId, result);
  await recordAudit(db, {
    actor: { subjectId: "agent-runtime", subjectType: "service" },
    requestId: runId,
    orgId: input.orgId,
    projectId: input.projectId,
    type: "bot.run.completed",
    source: "agent-runtime-worker",
    subjectKind: "project",
    subjectId: input.projectId,
    payload: { status: result.status, source: input.source, tokensIn: result.tokensIn, tokensOut: result.tokensOut, toolCalls: result.steps.filter((s) => s.kind === "tool").length },
  });
  return result;
}

/** The environment's AI Gateway base URL, from the AI binding (BYOK only). */
async function gatewayUrl(env: Env): Promise<{ baseUrl?: string }> {
  try {
    const gw = (env.AI as unknown as { gateway?: (id: string) => { getUrl: () => Promise<string> } })?.gateway?.(env.AI_GATEWAY_ID!);
    const url = gw ? await gw.getUrl() : null;
    return url ? { baseUrl: url } : {};
  } catch {
    return {};
  }
}

/** Grants → the policy's input map, keyed by the tool name the model sees. */
export function compileGrants(rows: GrantRow[]): { grants: Grants; builtinGranted: string[]; mcpGrants: GrantRow[] } {
  const grants: Grants = {};
  const builtinGranted: string[] = [];
  const mcpGrants: GrantRow[] = [];
  for (const g of rows) {
    const entry = { mode: g.mode, ...(g.argConstraints ? { argConstraints: g.argConstraints } : {}) };
    if (g.serverId === BUILTIN_SERVER_ID) {
      const names = g.toolName === "*" ? [...BUILTIN_TOOL_NAMES] : [g.toolName];
      for (const n of names) {
        grants[n] = entry;
        if (g.mode !== "deny" && !builtinGranted.includes(n)) builtinGranted.push(n);
      }
    } else {
      mcpGrants.push(g);
    }
  }
  return { grants, builtinGranted, mcpGrants };
}

export { mcpToolName };

async function meter(db: SqlExecutor, input: TurnInput, runId: string, r: TurnResult): Promise<void> {
  try {
    const repo = createMeteringRepository(db);
    const base = { orgId: input.orgId, projectId: null, resourceId: input.projectId, metadata: { source: input.source, model: r.model } };
    const toolCalls = r.steps.filter((s) => s.kind === "tool").length;
    await repo.ingestUsageBatch([
      { ...base, id: crypto.randomUUID(), metric: "agent_runs", quantity: 1, idempotencyKey: `${runId}:runs` },
      { ...base, id: crypto.randomUUID(), metric: "agent_tokens_in", quantity: r.tokensIn, idempotencyKey: `${runId}:tin` },
      { ...base, id: crypto.randomUUID(), metric: "agent_tokens_out", quantity: r.tokensOut, idempotencyKey: `${runId}:tout` },
      ...(toolCalls ? [{ ...base, id: crypto.randomUUID(), metric: "agent_tool_calls", quantity: toolCalls, idempotencyKey: `${runId}:tools` }] : []),
    ]);
  } catch {
    // Metering is best-effort; the run itself is recorded in agent_runs.
  }
}
