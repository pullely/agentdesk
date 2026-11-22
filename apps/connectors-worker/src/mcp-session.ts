import { DurableObject } from "cloudflare:workers";
import { checkRemoteUrl } from "@saas/agent-core/ssrf";
import { createAgentsRepository, createVault, kekRingFromEnv } from "@saas/db/agents";
import { createSqlExecutor } from "@saas/db/d1";
import type { Env } from "./env.js";
import { callTool, connect, McpError, type McpConnection } from "./mcp-client.js";

// McpSession — one Durable Object per org:server. It holds the live MCP
// session (the server's mcp-session-id) and the decrypted bearer in memory
// only, so tool calls across turns and threads reuse one connection; an
// expired session reconnects once. Concurrent calls per org are capped.

const MAX_INFLIGHT = 8;

export class McpSession extends DurableObject<Env> {
  private conn: McpConnection | null = null;
  private inflight = 0;

  override async fetch(request: Request): Promise<Response> {
    const { orgId, serverId, tool, arguments: args } = (await request.json()) as {
      orgId: string;
      serverId: string;
      tool: string;
      arguments: unknown;
    };
    if (this.inflight >= MAX_INFLIGHT) return Response.json({ error: { message: "Too many concurrent tool calls for this connector" } }, { status: 429 });
    this.inflight++;
    try {
      const result = await this.call(orgId, serverId, tool, args);
      return Response.json({ data: result });
    } catch (e) {
      return Response.json({ error: { message: (e as Error).message } }, { status: 502 });
    } finally {
      this.inflight--;
    }
  }

  private async open(orgId: string, serverId: string): Promise<McpConnection> {
    if (!this.env.PLATFORM_DB) throw new Error("PLATFORM_DB is not bound");
    const repo = createAgentsRepository(createSqlExecutor(this.env.PLATFORM_DB));
    const server = await repo.getServer(orgId, serverId);
    if (!server || server.status === "disabled") throw new Error("connector not found");
    const check = checkRemoteUrl(server.url, { ownWorkersDevPrefix: "agentdesk-" });
    if (!check.ok) throw new Error(`connector URL refused: ${check.reason}`);
    let bearer: string | null = null;
    if (server.authType === "bearer" && server.secretId) {
      const ring = kekRingFromEnv(this.env as unknown as Record<string, unknown>);
      if (!ring) throw new Error("vault not configured");
      bearer = await createVault(repo, ring).get(orgId, server.secretId);
    }
    return connect(server.url, bearer);
  }

  private async call(orgId: string, serverId: string, tool: string, args: unknown) {
    if (!this.conn) this.conn = await this.open(orgId, serverId);
    try {
      return await callTool(this.conn, tool, args);
    } catch (e) {
      if (e instanceof McpError && (e.sessionExpired || e.status === 401)) {
        this.conn = await this.open(orgId, serverId);
        return callTool(this.conn, tool, args);
      }
      throw e;
    }
  }
}
