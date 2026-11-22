import { BUILTIN_TOOL_NAMES, BUILTIN_SERVER_ID, parseModelRef } from "@saas/agent-core/refs";
import { createAgentsRepository, type GrantRow } from "@saas/db/agents";
import { createSqlExecutor } from "@saas/db/d1";
import {
  actorOf,
  actorUuid,
  authorize,
  dispatch,
  fail,
  invalid,
  list,
  notFound,
  ok,
  parsePublicId,
  readJson,
  recordAudit,
  requestIdOf,
  unauthenticated,
  unavailable,
} from "@saas/worker-kit";
import type { Env } from "./env.js";
import { publicGrant, publicProfile, publicRun, publicVersion } from "./mappers.js";

// bots-worker — agentdesk's bot bounded context (agentdesk-agent-bots §3).
// A bot is a Cirrus project: its profile, its versioned config (one draft,
// one published, immutable once published), its tool grants, publish, the
// playground relay to agent-runtime, and the runs the runtime recorded.

const P = "^/v1/organizations/([^/]+)/projects/([^/]+)";
const BOT = new RegExp(`${P}/bot$`);
const VERSIONS = new RegExp(`${P}/bot/versions$`);
const DRAFT = new RegExp(`${P}/bot/draft$`);
const PUBLISH = new RegExp(`${P}/bot/publish$`);
const PLAYGROUND = new RegExp(`${P}/bot/playground$`);
const GRANTS = new RegExp(`${P}/grants$`);
const RUNS = new RegExp(`${P}/runs$`);
const RUN = /^\/v1\/organizations\/([^/]+)\/runs\/([^/]+)$/;
const BOTS = /^\/v1\/organizations\/([^/]+)\/bots$/;

const MAX_PROMPT = 20_000;

export async function route(request: Request, env: Env): Promise<Response> {
  const requestId = requestIdOf(request);
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return ok({ status: "ok", service: "bots-worker", environment: env.ENVIRONMENT ?? "unknown", runtime: Boolean(env.AGENT_RUNTIME) }, requestId);
  }
  const actor = actorOf(request);
  if (!actor) return unauthenticated(requestId);
  if (!env.PLATFORM_DB) return unavailable(requestId);
  const db = createSqlExecutor(env.PLATFORM_DB);
  const repo = createAgentsRepository(db);

  // Resolve org + project from the path, check the project is the org's,
  // and ask policy about `action` on that project. Deny reads as not found.
  const gate = async (m: RegExpMatchArray, action: string) => {
    const orgId = parsePublicId(m[1], "org");
    const projectId = parsePublicId(m[2], "prj");
    if (!orgId || !projectId) return null;
    const [project, allowed] = await Promise.all([
      repo.projectInOrg(orgId, projectId),
      authorize(env, actor, action, { orgId, projectId }, requestId),
    ]);
    return project && allowed ? { orgId, projectId, project } : null;
  };

  const audit = (orgId: string, type: string, projectId: string, payload: Record<string, unknown>) =>
    recordAudit(db, { actor, requestId, orgId, projectId, type, source: "bots-worker", subjectKind: "project", subjectId: projectId, payload });

  return dispatch(
    request,
    [
      [
        "GET",
        BOTS,
        async (m) => {
          const orgId = parsePublicId(m[1], "org");
          if (!orgId || !(await authorize(env, actor, "project.list", { orgId }, requestId))) return notFound(requestId);
          return list((await repo.listProfiles(orgId)).map(publicProfile), requestId);
        },
      ],
      [
        "GET",
        BOT,
        async (m) => {
          const g = await gate(m, "run.read");
          if (!g) return notFound(requestId);
          const [profile, draft, published] = await Promise.all([
            repo.getProfile(g.orgId, g.projectId),
            repo.getVersionByStatus(g.orgId, g.projectId, "draft"),
            repo.getVersionByStatus(g.orgId, g.projectId, "published"),
          ]);
          return ok(
            {
              profile: profile ? publicProfile(profile) : null,
              draft: draft ? publicVersion(draft) : null,
              published: published ? publicVersion(published) : null,
            },
            requestId,
          );
        },
      ],
      [
        "PUT",
        BOT,
        async (m) => {
          const g = await gate(m, "bot.config.write");
          if (!g) return notFound(requestId);
          const body = await readJson<{ displayName?: string; description?: string; avatarUrl?: string }>(request);
          const fields: Record<string, string[]> = {};
          const displayName = (body?.displayName ?? g.project.name).toString().trim();
          if (!displayName || displayName.length > 80) fields.displayName = ["1–80 characters"];
          if (body?.avatarUrl && !/^https:\/\/\S+$/.test(body.avatarUrl)) fields.avatarUrl = ["an https URL"];
          if (body?.description && body.description.length > 500) fields.description = ["at most 500 characters"];
          if (Object.keys(fields).length) return invalid(requestId, fields);
          const profile = await repo.upsertProfile({
            orgId: g.orgId,
            projectId: g.projectId,
            displayName,
            description: body?.description ?? null,
            avatarUrl: body?.avatarUrl ?? null,
          });
          await audit(g.orgId, "bot.profile.updated", g.projectId, { displayName });
          return ok(publicProfile(profile), requestId);
        },
      ],
      [
        "GET",
        VERSIONS,
        async (m) => {
          const g = await gate(m, "run.read");
          if (!g) return notFound(requestId);
          return list((await repo.listVersions(g.orgId, g.projectId)).map(publicVersion), requestId);
        },
      ],
      [
        "GET",
        DRAFT,
        async (m) => {
          const g = await gate(m, "run.read");
          if (!g) return notFound(requestId);
          const draft = await repo.getVersionByStatus(g.orgId, g.projectId, "draft");
          return draft ? ok(publicVersion(draft), requestId) : fail("no_draft", "This bot has no draft", 404, requestId);
        },
      ],
      [
        "PUT",
        DRAFT,
        async (m) => {
          const g = await gate(m, "bot.config.write");
          if (!g) return notFound(requestId);
          const body = await readJson<{ systemPrompt?: string; modelRef?: string; providerKeyId?: string | null; params?: Record<string, unknown> }>(request);
          if (!body) return invalid(requestId, { body: ["a JSON object"] });
          const fields: Record<string, string[]> = {};
          if (body.systemPrompt !== undefined && (typeof body.systemPrompt !== "string" || body.systemPrompt.length > MAX_PROMPT)) {
            fields.systemPrompt = [`a string of at most ${MAX_PROMPT} characters`];
          }
          let providerKeyId: string | null | undefined = undefined;
          if (body.modelRef !== undefined) {
            try {
              const ref = parseModelRef(body.modelRef);
              if (ref.provider !== "workers-ai" && body.providerKeyId === undefined) fields.providerKeyId = ["a BYOK model needs a model key"];
            } catch (e) {
              fields.modelRef = [(e as Error).message];
            }
          }
          if (body.providerKeyId !== undefined) {
            if (body.providerKeyId === null) providerKeyId = null;
            else {
              const id = parsePublicId(body.providerKeyId, "lpk");
              const key = id ? await repo.getModelKey(g.orgId, id) : null;
              if (!key) fields.providerKeyId = ["not a model key of this organization"];
              else providerKeyId = key.id;
            }
          }
          const params: Record<string, number> = {};
          const p = body.params ?? {};
          if (p.temperature !== undefined) {
            if (typeof p.temperature !== "number" || p.temperature < 0 || p.temperature > 2) fields["params.temperature"] = ["0–2"];
            else params.temperature = p.temperature;
          }
          if (p.maxSteps !== undefined) {
            if (!Number.isInteger(p.maxSteps) || (p.maxSteps as number) < 1 || (p.maxSteps as number) > 20) fields["params.maxSteps"] = ["an integer 1–20"];
            else params.maxSteps = p.maxSteps as number;
          }
          if (p.maxOutputTokens !== undefined) {
            if (!Number.isInteger(p.maxOutputTokens) || (p.maxOutputTokens as number) < 64 || (p.maxOutputTokens as number) > 16000) fields["params.maxOutputTokens"] = ["an integer 64–16000"];
            else params.maxOutputTokens = p.maxOutputTokens as number;
          }
          if (Object.keys(fields).length) return invalid(requestId, fields);
          if (!(await repo.getProfile(g.orgId, g.projectId))) {
            await repo.upsertProfile({ orgId: g.orgId, projectId: g.projectId, displayName: g.project.name });
          }
          const draft = await repo.updateDraft(
            g.orgId,
            g.projectId,
            {
              ...(body.systemPrompt !== undefined ? { systemPrompt: body.systemPrompt } : {}),
              ...(body.modelRef !== undefined ? { modelRef: body.modelRef } : {}),
              ...(providerKeyId !== undefined ? { providerKeyId } : {}),
              params,
            },
            actorUuid(actor),
          );
          await audit(g.orgId, "bot.config.updated", g.projectId, { version: draft.version, modelRef: draft.modelRef });
          return ok(publicVersion(draft), requestId);
        },
      ],
      [
        "POST",
        PUBLISH,
        async (m) => {
          const g = await gate(m, "bot.publish");
          if (!g) return notFound(requestId);
          const grants = await repo.listGrants(g.orgId, g.projectId);
          const published = await repo.publishDraft(g.orgId, g.projectId, grants);
          if (!published) return fail("no_draft", "There is no draft to publish", 409, requestId);
          await audit(g.orgId, "bot.published", g.projectId, { version: published.version, grants: grants.length });
          return ok(publicVersion(published), requestId);
        },
      ],
      [
        "GET",
        GRANTS,
        async (m) => {
          const g = await gate(m, "run.read");
          if (!g) return notFound(requestId);
          return list((await repo.listGrants(g.orgId, g.projectId)).map(publicGrant), requestId);
        },
      ],
      [
        "PUT",
        GRANTS,
        async (m) => {
          const orgId = parsePublicId(m[1], "org");
          const projectId = parsePublicId(m[2], "prj");
          if (!orgId || !projectId) return notFound(requestId);
          const [project, allowed] = await Promise.all([
            repo.projectInOrg(orgId, projectId),
            authorize(env, actor, "connector.manage", { orgId }, requestId),
          ]);
          if (!project || !allowed) return notFound(requestId);
          const body = await readJson<{ grants?: unknown }>(request);
          const raw = Array.isArray(body) ? body : Array.isArray(body?.grants) ? body!.grants : null;
          if (!raw || (raw as unknown[]).length > 200) return invalid(requestId, { grants: ["an array of at most 200 grants"] });
          const servers = new Map((await repo.listServers(orgId)).map((s) => [s.id, s]));
          const rows: GrantRow[] = [];
          const errors: string[] = [];
          for (const [i, gr] of (raw as Record<string, unknown>[]).entries()) {
            const mode = gr.mode;
            const toolName = typeof gr.toolName === "string" ? gr.toolName : "";
            if (mode !== "allow" && mode !== "approve" && mode !== "deny") {
              errors.push(`${i}: mode must be allow, approve or deny`);
              continue;
            }
            let serverId: string;
            let descriptionHash: string | null = null;
            if (gr.serverId === BUILTIN_SERVER_ID) {
              serverId = BUILTIN_SERVER_ID;
              if (toolName !== "*" && !(BUILTIN_TOOL_NAMES as readonly string[]).includes(toolName)) {
                errors.push(`${i}: unknown built-in tool ${toolName}`);
                continue;
              }
            } else {
              const id = parsePublicId(String(gr.serverId ?? ""), "mcs");
              const server = id ? servers.get(id) : undefined;
              if (!server) {
                errors.push(`${i}: not an MCP server of this organization`);
                continue;
              }
              serverId = server.id;
              if (toolName !== "*") {
                const tool = server.tools.find((t) => t.name === toolName);
                if (!tool) {
                  errors.push(`${i}: ${server.name} has no tool ${toolName} (sync it first)`);
                  continue;
                }
                descriptionHash = tool.descriptionHash;
              }
            }
            const constraints = gr.argConstraints;
            if (constraints !== undefined && constraints !== null) {
              if (typeof constraints !== "object" || Object.values(constraints as object).some((v) => typeof v !== "string")) {
                errors.push(`${i}: argConstraints maps argument names to glob strings`);
                continue;
              }
            }
            rows.push({ serverId, toolName, mode, argConstraints: (constraints as Record<string, string>) ?? null, descriptionHash });
          }
          if (errors.length) return invalid(requestId, { grants: errors });
          const saved = await repo.replaceGrants(orgId, projectId, rows, actorUuid(actor));
          await audit(orgId, "grant.changed", projectId, { grants: saved.length });
          return list(saved.map(publicGrant), requestId);
        },
      ],
      [
        "POST",
        PLAYGROUND,
        async (m) => {
          const g = await gate(m, "bot.config.write");
          if (!g) return notFound(requestId);
          if (!env.AGENT_RUNTIME) return fail("runtime_unavailable", "The agent runtime is not deployed in this environment yet", 503, requestId);
          const body = await readJson<{ messages?: unknown }>(request);
          const messages = Array.isArray(body?.messages) ? (body!.messages as { role?: unknown; content?: unknown }[]) : null;
          if (!messages || messages.length === 0 || messages.length > 50 || messages.some((x) => (x.role !== "user" && x.role !== "assistant") || typeof x.content !== "string" || (x.content as string).length > 8000)) {
            return invalid(requestId, { messages: ["1–50 {role: user|assistant, content} messages"] });
          }
          const res = await env.AGENT_RUNTIME.fetch("https://agent-runtime.internal/internal/playground", {
            method: "POST",
            headers: { "content-type": "application/json", "x-request-id": requestId },
            body: JSON.stringify({ orgId: g.orgId, projectId: g.projectId, messages, userName: actor.email ?? undefined }),
          });
          return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
        },
      ],
      [
        "GET",
        RUNS,
        async (m) => {
          const g = await gate(m, "run.read");
          if (!g) return notFound(requestId);
          const limit = Number(url.searchParams.get("limit") ?? 50);
          const before = url.searchParams.get("before") ?? undefined;
          const runs = await repo.listRuns(g.orgId, g.projectId, { limit, ...(before ? { before } : {}) });
          return list(runs.map(publicRun), requestId, runs.length ? runs[runs.length - 1]!.startedAt : null);
        },
      ],
      [
        "GET",
        RUN,
        async (m) => {
          const orgId = parsePublicId(m[1], "org");
          const runId = parsePublicId(m[2], "run");
          if (!orgId || !runId) return notFound(requestId);
          const run = await repo.getRun(orgId, runId);
          if (!run || !(await authorize(env, actor, "run.read", { orgId, projectId: run.projectId }, requestId))) return notFound(requestId);
          return ok(publicRun(run), requestId);
        },
      ],
    ],
    requestId,
  );
}
