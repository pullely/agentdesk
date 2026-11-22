import type { AgentRun, AgentRunStep, BotConfigVersion, BotProfile, GrantRow } from "@saas/db/agents";
import { toPublicId } from "@saas/worker-kit";

export const publicGrant = (g: GrantRow) => ({
  serverId: g.serverId === "builtin" ? "builtin" : toPublicId("mcs", g.serverId),
  toolName: g.toolName,
  mode: g.mode,
  argConstraints: g.argConstraints ?? null,
});

export const publicProfile = (p: BotProfile) => ({
  projectId: toPublicId("prj", p.projectId),
  displayName: p.displayName,
  description: p.description,
  avatarUrl: p.avatarUrl,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

export const publicVersion = (v: BotConfigVersion) => ({
  id: toPublicId("bcv", v.id),
  version: v.version,
  status: v.status,
  systemPrompt: v.systemPrompt,
  modelRef: v.modelRef,
  providerKeyId: v.providerKeyId ? toPublicId("lpk", v.providerKeyId) : null,
  params: v.params,
  toolGrants: v.toolGrants.map(publicGrant),
  createdAt: v.createdAt,
  updatedAt: v.updatedAt,
  publishedAt: v.publishedAt,
});

export const publicRun = (r: AgentRun & { steps?: AgentRunStep[] }) => ({
  id: toPublicId("run", r.id),
  projectId: toPublicId("prj", r.projectId),
  configVersionId: r.configVersionId ? toPublicId("bcv", r.configVersionId) : null,
  env: r.env,
  source: r.source,
  channelId: r.channelId,
  threadTs: r.threadTs,
  model: r.model,
  status: r.status,
  tokensIn: r.tokensIn,
  tokensOut: r.tokensOut,
  latencyMs: r.latencyMs,
  error: r.error,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  ...(r.steps ? { steps: r.steps } : {}),
});
