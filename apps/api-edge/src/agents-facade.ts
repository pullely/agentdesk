import type { Env } from "./env.js";
import { errorResponse } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";

// agentdesk (agentdesk-agent-bots): the authenticated routes of the four
// agent bounded contexts and the vault's model keys, forwarded to the Worker
// that owns each one with the actor headers every baseline facade sets. One
// table, so a new route group is one row. Matched before the generic project
// and org facades.

type Target = "CONFIG_WORKER" | "BOTS_WORKER" | "CONNECTORS_WORKER" | "SLACK_GATEWAY_WORKER";

const ROUTES: [RegExp, Target][] = [
  [/^\/v1\/organizations\/[^/]+\/model-keys(\/[^/]+(\/verify)?)?$/, "CONFIG_WORKER"],
  // bots-worker (AD-3): a bot per project, its config, grants, playground, runs.
  [/^\/v1\/organizations\/[^/]+\/bots$/, "BOTS_WORKER"],
  [/^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/bot(\/(versions|draft|publish|playground))?$/, "BOTS_WORKER"],
  [/^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/(grants|runs)$/, "BOTS_WORKER"],
  [/^\/v1\/organizations\/[^/]+\/runs\/[^/]+$/, "BOTS_WORKER"],
  // slack-gateway-worker (AD-5): installations, the install URL, bindings.
  [/^\/v1\/organizations\/[^/]+\/slack\/(installations(\/[^/]+)?|install-url)$/, "SLACK_GATEWAY_WORKER"],
  [/^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/slack\/bindings$/, "SLACK_GATEWAY_WORKER"],
];

const FORWARDED_HEADERS = ["content-type", "traceparent", "idempotency-key"];

export function agentsTarget(pathname: string): Target | null {
  for (const [re, target] of ROUTES) if (re.test(pathname)) return target;
  return null;
}

export function isAgentsRoute(pathname: string): boolean {
  return agentsTarget(pathname) !== null;
}

export async function handleAgentsRoute(request: Request, env: Env, requestId: string, pathname: string): Promise<Response> {
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }
  const targetName = agentsTarget(pathname)!;
  return replayOrExecute(request, requestId, env, "agents", async () => {
    const worker = (env as unknown as Record<string, Fetcher | undefined>)[targetName];
    if (!env.IDENTITY_WORKER || !worker) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    const session = await resolveActor(request, env, requestId);
    if ("error" in session) return session.error;

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", session.subjectId);
    headers.set("x-actor-subject-type", session.subjectType);
    headers.set("x-actor-email", session.email);
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const url = new URL(request.url);
    const init: RequestInit = { method: request.method, headers };
    if (request.method !== "GET" && request.method !== "DELETE") init.body = request.body;
    try {
      const downstream = await worker.fetch(new URL(pathname + url.search, "https://agents.internal").toString(), init);
      return new Response(downstream.body, { status: downstream.status, headers: downstream.headers });
    } catch {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
  });
}
