import { fail, ok, requestIdOf } from "@saas/worker-kit";
import { handleAdmin, handleOAuthCallback, isAdminRoute } from "./admin.js";
import type { Env } from "./env.js";
import { handleCommand, handleEvents, handleInteractivity } from "./ingress.js";
import { manifest } from "./manifest.js";

// slack-gateway-worker — public ingress for Slack (its own workers.dev host,
// not behind api-edge) plus the authenticated installation and binding
// routes that api-edge's agents facade forwards here.

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    const requestId = requestIdOf(request);
    try {
      if (pathname === "/health" && request.method === "GET") {
        return ok(
          {
            status: "ok",
            service: "slack-gateway-worker",
            environment: env.ENVIRONMENT ?? "unknown",
            slack: env.SLACK_SIGNING_SECRET ? "configured" : "not configured",
            oauth: Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.OAUTH_STATE_SECRET),
            vault: Boolean(env.VAULT_KEK_V1),
            runtime: Boolean(env.AGENT_RUNTIME),
          },
          requestId,
        );
      }
      if (request.method === "POST" && pathname === "/slack/events") return await handleEvents(request, env, ctx);
      if (request.method === "POST" && pathname === "/slack/commands") return await handleCommand(request, env, ctx);
      if (request.method === "POST" && pathname === "/slack/interactivity") return await handleInteractivity(request, env);
      if (request.method === "GET" && pathname === "/slack/oauth/callback") return await handleOAuthCallback(request, env);
      if (request.method === "GET" && pathname === "/slack/manifest.json") return Response.json(manifest(env, new URL(request.url).host));
      if (isAdminRoute(pathname)) return await handleAdmin(request, env, requestId);
      return fail("not_found", `Route not found: ${pathname}`, 404, requestId);
    } catch (err) {
      console.error("slack-gateway-worker: unhandled", err instanceof Error ? err.message : "error");
      return fail("internal_error", "Internal error", 500, requestId);
    }
  },
} satisfies ExportedHandler<Env>;
