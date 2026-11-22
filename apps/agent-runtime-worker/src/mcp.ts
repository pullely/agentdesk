import { jsonSchema, tool, type ToolSet } from "ai";
import { mcpToolName, untrusted, type Grants } from "@saas/agent-core";
import type { AgentsRepository, GrantRow } from "@saas/db/agents";
import type { Env } from "./env.js";

// MCP tools for one turn: the bot's granted tools on the org's registered
// servers, from connectors-worker's tool cache, each executed through
// connectors-worker (which holds the McpSession and the server's token).
// Until connectors-worker is deployed (AD-6) a bot has built-ins only.

const MAX_OUTPUT = 64 * 1024;

export async function mcpToolsFor(
  env: Env,
  repo: AgentsRepository,
  orgId: string,
  projectId: string,
  mcpGrants: GrantRow[],
  grants: Grants,
): Promise<ToolSet> {
  if (mcpGrants.length === 0) return {};
  const servers = new Map((await repo.listServers(orgId)).filter((s) => s.status !== "disabled").map((s) => [s.id, s]));
  const tools: ToolSet = {};
  for (const g of mcpGrants) {
    const server = servers.get(g.serverId);
    if (!server) continue;
    const candidates = g.toolName === "*" ? server.tools : server.tools.filter((t) => t.name === g.toolName);
    for (const t of candidates) {
      const name = mcpToolName(server.name, t.name);
      // A description that changed since the admin granted it is not offered
      // until re-approved (tool-poisoning guard). Wildcard grants record none.
      if (g.toolName !== "*" && g.descriptionHash && g.descriptionHash !== t.descriptionHash) {
        delete grants[name];
        continue;
      }
      if (g.mode === "deny") {
        grants[name] = { mode: "deny" };
        continue;
      }
      grants[name] = { mode: g.mode, ...(g.argConstraints ? { argConstraints: g.argConstraints } : {}) };
      tools[name] = tool({
        description: `[${server.name}] ${t.description}`.slice(0, 1024),
        inputSchema: jsonSchema((t.inputSchema as object) ?? { type: "object", properties: {} }),
        execute: async (args: unknown) => {
          if (!env.CONNECTORS_WORKER) throw new Error("MCP connectors are not deployed in this environment");
          const res = await env.CONNECTORS_WORKER.fetch("https://connectors.internal/internal/call", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ orgId, projectId, serverId: server.id, tool: t.name, arguments: args }),
          });
          const body = (await res.json().catch(() => null)) as { data?: { content?: unknown; isError?: boolean }; error?: { message?: string } } | null;
          if (!res.ok || !body?.data) throw new Error(body?.error?.message ?? `MCP call failed (${res.status})`);
          let out = JSON.stringify(body.data.content ?? null);
          if (out.length > MAX_OUTPUT) out = `${out.slice(0, MAX_OUTPUT)}…[truncated]`;
          if (body.data.isError) throw new Error(out.slice(0, 2000));
          return untrusted(out);
        },
      });
    }
  }
  return tools;
}
