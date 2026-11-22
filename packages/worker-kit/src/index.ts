// @saas/worker-kit — the request plumbing agentdesk's four new Workers share
// (bots, slack-gateway, agent-runtime, connectors): the baseline's envelope,
// actor headers set by api-edge, public ids, and one authorize() that runs
// the membership + policy check every baseline Worker runs, failing closed.
import type { SqlExecutor } from "@saas/db/d1";
import { createEventsRepository } from "@saas/db/events";
import { hexToUuid, uuidToHex } from "@saas/db/ids";

export type { Fetcher } from "@cloudflare/workers-types";

export interface Actor {
  subjectId: string;
  subjectType: string;
  email?: string | null;
}

/** The actor's bare UUID for created_by-style columns (usr_<hex> / sp_<hex> decoded). */
export function actorUuid(actor: Actor): string | null {
  const i = actor.subjectId.indexOf("_");
  if (i <= 0) return null;
  return hexToUuid(actor.subjectId.slice(i + 1));
}

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export function requestIdOf(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  return `req_${[...buf].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function actorOf(request: Request): Actor | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType, email: request.headers.get("x-actor-email") };
}

// ── envelopes ──────────────────────────────────────────────

export function ok<T>(data: T, requestId: string, status = 200): Response {
  return Response.json({ data, meta: { requestId, cursor: null } }, { status });
}

export function list<T>(data: T[], requestId: string, cursor: string | null = null): Response {
  return Response.json({ data, meta: { requestId, cursor } }, { status: 200 });
}

export function fail(code: string, message: string, status: number, requestId: string, details?: Record<string, unknown>): Response {
  return Response.json({ error: { code, message, details: details ?? {}, requestId } }, { status });
}

export const notFound = (requestId: string, what = "Not found") => fail("not_found", what, 404, requestId);
export const unauthenticated = (requestId: string) => fail("unauthenticated", "Authentication required", 401, requestId);
export const invalid = (requestId: string, fields: Record<string, string[]>) =>
  fail("validation_failed", "Validation failed", 422, requestId, { fields });
export const unavailable = (requestId: string) => fail("internal_error", "Service unavailable", 503, requestId);

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T | null> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" ? (body as T) : null;
  } catch {
    return null;
  }
}

// ── public ids ─────────────────────────────────────────────

export function parsePublicId(publicId: string | undefined, prefix: string): string | null {
  if (!publicId || !publicId.startsWith(`${prefix}_`)) return null;
  return hexToUuid(publicId.slice(prefix.length + 1));
}

export function toPublicId(prefix: string, uuid: string): string {
  return `${prefix}_${uuidToHex(uuid)}`;
}

// ── authorization ──────────────────────────────────────────

export interface AuthzBindings {
  MEMBERSHIP_WORKER?: { fetch: (input: string, init?: RequestInit) => Promise<Response> };
  POLICY_WORKER?: { fetch: (input: string, init?: RequestInit) => Promise<Response> };
}

/**
 * The baseline's two-step check: the actor's memberships from
 * membership-worker, then policy-worker's decision on `action` over the org
 * (or one of its projects). Any failure is a deny.
 */
export async function authorize(
  env: AuthzBindings,
  actor: Actor,
  action: string,
  resource: { orgId: string; projectId?: string },
  requestId: string,
): Promise<boolean> {
  if (!env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) return false;
  try {
    const ctx = await env.MEMBERSHIP_WORKER.fetch("http://membership-worker/v1/internal/membership/authorization-context", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify({ subject: { type: actor.subjectType, id: actor.subjectId }, orgId: resource.orgId }),
    });
    if (!ctx.ok) return false;
    const memberships = ((await ctx.json()) as { data?: { memberships?: unknown[] } })?.data?.memberships;
    if (!Array.isArray(memberships)) return false;
    const res = await env.POLICY_WORKER.fetch("http://policy-worker/v1/internal/policy/authorize", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify({
        subject: { type: actor.subjectType, id: actor.subjectId },
        action,
        resource: resource.projectId
          ? { kind: "project", orgId: resource.orgId, projectId: resource.projectId }
          : { kind: "organization", orgId: resource.orgId },
        context: { memberships },
      }),
    });
    if (!res.ok) return false;
    const data = ((await res.json()) as { data?: { allow?: unknown } })?.data;
    return data?.allow === true;
  } catch {
    return false;
  }
}

/** A tiny path router: `[method, regex, handler(match)]`, first match wins. */
export type Handler = (m: RegExpMatchArray) => Promise<Response> | Response;
export async function dispatch(
  request: Request,
  routes: [string, RegExp, Handler][],
  requestId: string,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  let pathMatched = false;
  for (const [method, re, handler] of routes) {
    const m = pathname.match(re);
    if (!m) continue;
    pathMatched = true;
    if (method === request.method || (method === "GET" && request.method === "HEAD")) return handler(m);
  }
  return pathMatched ? fail("unsupported", "Method not allowed", 405, requestId) : fail("not_found", `Route not found: ${pathname}`, 404, requestId);
}

// ── audit ──────────────────────────────────────────────────

/**
 * Append an audit event the way baseline Workers do (events-worker has no
 * write route; the event and its audit entry go to the shared D1 directly).
 * Best-effort: the write it describes already happened. Payloads must be
 * redaction-safe — names and counts, never values.
 */
export async function recordAudit(
  db: SqlExecutor,
  input: {
    actor: Actor | { subjectId: string; subjectType: string };
    requestId: string;
    orgId: string;
    projectId?: string | null;
    type: string;
    source: string;
    subjectKind: string;
    subjectId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await createEventsRepository(db).appendEventWithAudit({
      event: {
        id: crypto.randomUUID(),
        type: input.type,
        version: 1,
        source: input.source,
        occurredAt: new Date(),
        actorType: input.actor.subjectType,
        actorId: input.actor.subjectId,
        orgId: input.orgId,
        projectId: input.projectId ?? null,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        requestId: input.requestId,
        payload: input.payload,
      },
      audit: { id: crypto.randomUUID(), category: "agents", description: input.type, projectId: input.projectId ?? null },
    });
  } catch {
    // best-effort
  }
}
