import type { ModelMessage } from "ai";
import { parseModelRef } from "@saas/agent-core";
import { fail, invalid, ok, readJson, requestIdOf, toPublicId } from "@saas/worker-kit";
import type { Env } from "./env.js";
import { loadBot, repoFor, runTurn } from "./engine.js";
import { threadName, type SlackTurn } from "./thread-agent.js";

export { ThreadAgent } from "./thread-agent.js";

// agent-runtime-worker — internal only (workers_dev off): reached by
// slack-gateway-worker (POST /internal/turn → the thread's ThreadAgent) and
// bots-worker (POST /internal/playground, the draft config, no Slack).

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = requestIdOf(request);
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/health") {
        const model = parseModelRef(null);
        return ok(
          {
            status: "ok",
            service: "agent-runtime-worker",
            environment: env.ENVIRONMENT ?? "unknown",
            model: { provider: model.provider, id: model.id },
            gateway: env.AI_GATEWAY_ID ?? null,
            vault: Boolean(env.VAULT_KEK_V1),
            threads: Boolean(env.THREAD_AGENT),
            connectors: Boolean(env.CONNECTORS_WORKER),
          },
          requestId,
        );
      }

      if (request.method === "POST" && pathname === "/internal/turn") {
        if (!env.THREAD_AGENT) return fail("internal_error", "ThreadAgent not bound", 503, requestId);
        const turn = await readJson<SlackTurn>(request);
        if (!turn?.orgId || !turn.projectId || !turn.teamId || !turn.channelId || !turn.threadTs || !turn.eventTs || !turn.botTokenSecretId) {
          return invalid(requestId, { turn: ["orgId, projectId, teamId, channelId, threadTs, eventTs and botTokenSecretId are required"] });
        }
        const stub = env.THREAD_AGENT.get(env.THREAD_AGENT.idFromName(threadName(turn)));
        const res = await stub.fetch("https://thread-agent/turn", { method: "POST", body: JSON.stringify(turn) });
        return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
      }

      if (request.method === "POST" && pathname === "/internal/playground") {
        const body = await readJson<{ orgId?: string; projectId?: string; messages?: ModelMessage[]; userName?: string }>(request);
        if (!body?.orgId || !body.projectId || !Array.isArray(body.messages)) {
          return invalid(requestId, { body: ["orgId, projectId and messages are required"] });
        }
        const { repo } = repoFor(env);
        const bot = await loadBot(repo, body.orgId, body.projectId, { kind: "draft" });
        if (!bot) return fail("no_draft", "This bot has no configuration yet — save a draft first", 409, requestId);
        const result = await runTurn(env, bot, {
          orgId: body.orgId,
          projectId: body.projectId,
          env: env.ENVIRONMENT === "prod" ? "prod" : "stage",
          source: "playground",
          messages: body.messages,
          userName: body.userName,
        });
        const run = await repo.getRun(body.orgId, result.runId);
        return ok(
          {
            reply: result.reply,
            run: run && {
              id: toPublicId("run", run.id),
              status: run.status,
              model: result.model,
              tokensIn: run.tokensIn,
              tokensOut: run.tokensOut,
              latencyMs: run.latencyMs,
              error: run.error,
              steps: run.steps,
            },
          },
          requestId,
        );
      }

      return fail("not_found", `Route not found: ${pathname}`, 404, requestId);
    } catch (err) {
      console.error("agent-runtime-worker: unhandled", err instanceof Error ? err.message : "error");
      return fail("internal_error", "Internal error", 500, requestId);
    }
  },
} satisfies ExportedHandler<Env>;
