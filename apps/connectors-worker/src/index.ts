import { checkRemoteUrl } from "@saas/agent-core/ssrf";
import { SERVER_NAME_RE } from "@saas/agent-core/refs";
import { createAgentsRepository, createVault, kekRingFromEnv, type CachedTool, type ConnectorServer } from "@saas/db/agents";
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
  toPublicId,
  unauthenticated,
  unavailable,
} from "@saas/worker-kit";
import type { Env } from "./env.js";
import { connect, descriptionHash, listTools } from "./mcp-client.js";

export { McpSession } from "./mcp-session.js";

// connectors-worker — the org's MCP server registry: add a remote MCP server
// by URL (none or bearer auth), discover and cache its tools, sync, remove;
// and execute a granted tool for agent-runtime through the server's
// McpSession. Grants themselves live with the bot's config (bots-worker).

const SERVERS = /^\/v1\/organizations\/([^/]+)\/connectors$/;
const SERVER = /^\/v1\/organizations\/([^/]+)\/connectors\/([^/]+)$/;
const SYNC = /^\/v1\/organizations\/([^/]+)\/connectors\/([^/]+)\/sync$/;

export const publicServer = (s: ConnectorServer) => ({
  id: toPublicId("mcs", s.id),
  name: s.name,
  url: s.url,
  transport: s.transport,
  authType: s.authType,
  status: s.status,
  tools: s.tools.map((t) => ({ name: t.name, description: t.description, descriptionHash: t.descriptionHash })),
  toolsSyncedAt: s.toolsSyncedAt,
  lastError: s.lastError,
  createdAt: s.createdAt,
});

async function discover(url: string, bearer: string | null): Promise<CachedTool[]> {
  const conn = await connect(url, bearer);
  const tools = await listTools(conn);
  return Promise.all(
    tools.map(async (t) => ({
      name: t.name,
      description: (t.description ?? "").slice(0, 2000),
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      descriptionHash: await descriptionHash(t),
    })),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = requestIdOf(request);
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/health") {
        return ok({ status: "ok", service: "connectors-worker", environment: env.ENVIRONMENT ?? "unknown", vault: Boolean(env.VAULT_KEK_V1), sessions: Boolean(env.MCP_SESSION) }, requestId);
      }
      if (!env.PLATFORM_DB) return unavailable(requestId);
      const db = createSqlExecutor(env.PLATFORM_DB);
      const repo = createAgentsRepository(db);

      // Internal: agent-runtime executes a granted tool (service binding only;
      // this Worker has no public route).
      if (request.method === "POST" && pathname === "/internal/call") {
        const body = await readJson<{ orgId?: string; projectId?: string; serverId?: string; tool?: string; arguments?: unknown }>(request);
        if (!body?.orgId || !body.projectId || !body.serverId || !body.tool) return invalid(requestId, { body: ["orgId, projectId, serverId and tool are required"] });
        // Defence in depth: the runtime only offers granted tools, and this
        // re-checks that a non-deny grant exists for this bot.
        const grants = await repo.listGrants(body.orgId, body.projectId);
        const granted = grants.some((g) => g.serverId === body.serverId && (g.toolName === body.tool || g.toolName === "*") && g.mode !== "deny");
        if (!granted) return fail("forbidden", "This tool is not granted to this bot", 403, requestId);
        if (!env.MCP_SESSION) return fail("internal_error", "McpSession not bound", 503, requestId);
        const stub = env.MCP_SESSION.get(env.MCP_SESSION.idFromName(`${body.orgId}:${body.serverId}`));
        const res = await stub.fetch("https://mcp-session/call", { method: "POST", body: JSON.stringify(body) });
        return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
      }

      const actor = actorOf(request);
      if (!actor) return unauthenticated(requestId);
      const gate = async (m: RegExpMatchArray) => {
        const orgId = parsePublicId(m[1], "org");
        return orgId && (await authorize(env, actor, "connector.manage", { orgId }, requestId)) ? orgId : null;
      };
      const ring = kekRingFromEnv(env as unknown as Record<string, unknown>);

      return dispatch(
        request,
        [
          [
            "GET",
            SERVERS,
            async (m) => {
              const orgId = await gate(m);
              if (!orgId) return notFound(requestId);
              return list((await repo.listServers(orgId)).map(publicServer), requestId);
            },
          ],
          [
            "POST",
            SERVERS,
            async (m) => {
              const orgId = await gate(m);
              if (!orgId) return notFound(requestId);
              const body = await readJson<{ name?: string; url?: string; authType?: string; token?: string }>(request);
              const fields: Record<string, string[]> = {};
              const name = String(body?.name ?? "").toLowerCase();
              if (!SERVER_NAME_RE.test(name)) fields.name = ["a slug: lowercase letters, digits and dashes, 2–31 characters"];
              const authType = (body?.authType ?? "none") as "none" | "bearer";
              if (authType !== "none" && authType !== "bearer") fields.authType = ["none or bearer (OAuth arrives in AD2)"];
              if (authType === "bearer" && (!body?.token || body.token.length < 8)) fields.token = ["a bearer token"];
              const check = checkRemoteUrl(String(body?.url ?? ""), { ownWorkersDevPrefix: "agentdesk-" });
              if (!check.ok) fields.url = [check.reason];
              if (Object.keys(fields).length) return invalid(requestId, fields);
              if ((await repo.listServers(orgId)).some((s) => s.name === name)) return fail("conflict", `A connector named ${name} already exists`, 409, requestId);
              if (authType === "bearer" && !ring) return fail("vault_not_configured", "The vault key is not configured for this environment", 503, requestId);
              // Discover before storing: a server we cannot reach is not added.
              let tools: CachedTool[];
              try {
                tools = await discover(check.ok ? check.url.toString() : "", authType === "bearer" ? body!.token! : null);
              } catch (e) {
                return fail("connector_unreachable", (e as Error).message, 422, requestId);
              }
              const secretId = authType === "bearer" ? await createVault(repo, ring!).put(orgId, "mcp_token", body!.token!) : null;
              const server = await repo.insertServer({ orgId, name, url: check.ok ? check.url.toString() : "", transport: "streamable-http", authType, secretId, createdBy: actorUuid(actor) });
              await repo.updateServerTools(orgId, server.id, { tools });
              await recordAudit(db, { actor, requestId, orgId, type: "connector.added", source: "connectors-worker", subjectKind: "connector", subjectId: server.id, payload: { name, authType, tools: tools.length } });
              return ok(publicServer((await repo.getServer(orgId, server.id))!), requestId, 201);
            },
          ],
          [
            "GET",
            SERVER,
            async (m) => {
              const orgId = await gate(m);
              const id = parsePublicId(m[2], "mcs");
              const s = orgId && id ? await repo.getServer(orgId, id) : null;
              return s ? ok(publicServer(s), requestId) : notFound(requestId);
            },
          ],
          [
            "POST",
            SYNC,
            async (m) => {
              const orgId = await gate(m);
              const id = parsePublicId(m[2], "mcs");
              const s = orgId && id ? await repo.getServer(orgId, id) : null;
              if (!s) return notFound(requestId);
              let bearer: string | null = null;
              if (s.authType === "bearer" && s.secretId) {
                if (!ring) return fail("vault_not_configured", "The vault key is not configured", 503, requestId);
                bearer = await createVault(repo, ring).get(orgId!, s.secretId);
              }
              try {
                const tools = await discover(s.url, bearer);
                const before = new Map(s.tools.map((t) => [t.name, t.descriptionHash]));
                const changed = tools.filter((t) => before.has(t.name) && before.get(t.name) !== t.descriptionHash).map((t) => t.name);
                await repo.updateServerTools(orgId!, s.id, { tools });
                await recordAudit(db, { actor, requestId, orgId: orgId!, type: "connector.synced", source: "connectors-worker", subjectKind: "connector", subjectId: s.id, payload: { tools: tools.length, changed } });
                return ok({ ...publicServer((await repo.getServer(orgId!, s.id))!), changedTools: changed }, requestId);
              } catch (e) {
                await repo.updateServerTools(orgId!, s.id, { error: (e as Error).message });
                return fail("connector_unreachable", (e as Error).message, 502, requestId);
              }
            },
          ],
          [
            "DELETE",
            SERVER,
            async (m) => {
              const orgId = await gate(m);
              const id = parsePublicId(m[2], "mcs");
              const s = orgId && id ? await repo.deleteServer(orgId, id) : null;
              if (!s) return notFound(requestId);
              await recordAudit(db, { actor, requestId, orgId: orgId!, type: "connector.removed", source: "connectors-worker", subjectKind: "connector", subjectId: s.id, payload: { name: s.name } });
              return ok({ id: m[2], deleted: true }, requestId);
            },
          ],
        ],
        requestId,
      );
    } catch (err) {
      console.error("connectors-worker: unhandled", err instanceof Error ? err.message : "error");
      return fail("internal_error", "Internal error", 500, requestId);
    }
  },
} satisfies ExportedHandler<Env>;
