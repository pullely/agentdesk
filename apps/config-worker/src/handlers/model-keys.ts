import { createAgentsRepository, createVault, kekRingFromEnv, last4, type ModelKey, type ModelKeyProvider } from "@saas/db/agents";
import { createSqlExecutor } from "@saas/db/d1";
import { verifyProviderKey } from "@saas/agent-core/verify";
import { actorOf, actorUuid, authorize, dispatch, fail, invalid, list, notFound, ok, parsePublicId, readJson, toPublicId, unauthenticated, unavailable } from "@saas/worker-kit";
import type { Env } from "../env.js";

// agentdesk (AD-2): the org's BYOK model keys. The key is posted once,
// verified with a model-list call, encrypted into the vault, and never
// returned — the API answers with its label and last four characters.

const PROVIDERS: ModelKeyProvider[] = ["openai", "anthropic", "google", "openai-compatible", "exa"];
const KEYS_RE = /^\/v1\/organizations\/([^/]+)\/model-keys$/;
const KEY_RE = /^\/v1\/organizations\/([^/]+)\/model-keys\/([^/]+)$/;
const KEY_VERIFY_RE = /^\/v1\/organizations\/([^/]+)\/model-keys\/([^/]+)\/verify$/;

export function isModelKeysRoute(pathname: string): boolean {
  return KEYS_RE.test(pathname) || KEY_RE.test(pathname) || KEY_VERIFY_RE.test(pathname);
}

export function toPublicModelKey(k: ModelKey) {
  return {
    id: toPublicId("lpk", k.id),
    provider: k.provider,
    label: k.label,
    baseUrl: k.baseUrl,
    last4: k.last4,
    status: k.status,
    lastVerifiedAt: k.lastVerifiedAt,
    createdAt: k.createdAt,
  };
}

export async function handleModelKeys(request: Request, env: Env, requestId: string): Promise<Response> {
  const actor = actorOf(request);
  if (!actor) return unauthenticated(requestId);
  if (!env.PLATFORM_DB) return unavailable(requestId);
  const repo = createAgentsRepository(createSqlExecutor(env.PLATFORM_DB));

  const gate = async (orgPublic: string | undefined) => {
    const orgId = parsePublicId(orgPublic, "org");
    if (!orgId) return { orgId: null, denied: notFound(requestId) };
    const allowed = await authorize(env, actor, "provider_key.manage", { orgId }, requestId);
    return allowed ? { orgId, denied: null } : { orgId: null, denied: notFound(requestId) };
  };

  return dispatch(
    request,
    [
      [
        "GET",
        KEYS_RE,
        async (m) => {
          const g = await gate(m[1]);
          if (g.denied) return g.denied;
          return list((await repo.listModelKeys(g.orgId!)).map(toPublicModelKey), requestId);
        },
      ],
      [
        "POST",
        KEYS_RE,
        async (m) => {
          const g = await gate(m[1]);
          if (g.denied) return g.denied;
          const ring = kekRingFromEnv(env as unknown as Record<string, unknown>);
          if (!ring) return fail("vault_not_configured", "The vault key is not configured for this environment", 503, requestId);
          const body = await readJson<{ provider?: string; label?: string; key?: string; baseUrl?: string }>(request);
          const fields: Record<string, string[]> = {};
          if (!body?.provider || !PROVIDERS.includes(body.provider as ModelKeyProvider)) fields.provider = [`one of ${PROVIDERS.join(", ")}`];
          if (!body?.key || typeof body.key !== "string" || body.key.length < 8 || body.key.length > 512) fields.key = ["8–512 characters"];
          if (body?.provider === "openai-compatible" && !/^https:\/\//.test(body.baseUrl ?? "")) fields.baseUrl = ["an https base URL is required"];
          if (Object.keys(fields).length) return invalid(requestId, fields);
          const provider = body!.provider as ModelKeyProvider;
          const value = body!.key!.trim();
          const check = await verifyProviderKey({ provider, apiKey: value, baseUrl: body!.baseUrl ?? null });
          if (!check.ok) return fail("model_key_invalid", `The ${provider} key was refused (HTTP ${check.status || "unreachable"})`, 422, requestId);
          const vault = createVault(repo, ring);
          const secretId = await vault.put(g.orgId!, provider === "exa" ? "tool_key" : "llm_key", value);
          const key = await repo.insertModelKey({
            orgId: g.orgId!,
            provider,
            label: (body!.label ?? provider).toString().slice(0, 80),
            baseUrl: body!.baseUrl ?? null,
            secretId,
            last4: last4(value),
            status: "valid",
            lastVerifiedAt: new Date().toISOString(),
            createdBy: actorUuid(actor),
          });
          return ok(toPublicModelKey(key), requestId, 201);
        },
      ],
      [
        "POST",
        KEY_VERIFY_RE,
        async (m) => {
          const g = await gate(m[1]);
          if (g.denied) return g.denied;
          const id = parsePublicId(m[2], "lpk");
          const key = id ? await repo.getModelKey(g.orgId!, id) : null;
          const ring = kekRingFromEnv(env as unknown as Record<string, unknown>);
          if (!key) return notFound(requestId);
          if (!ring) return fail("vault_not_configured", "The vault key is not configured for this environment", 503, requestId);
          const value = await createVault(repo, ring).get(g.orgId!, key.secretId);
          const check = value ? await verifyProviderKey({ provider: key.provider, apiKey: value, baseUrl: key.baseUrl }) : { ok: false };
          await repo.setModelKeyStatus(g.orgId!, key.id, check.ok ? "valid" : "invalid");
          return ok(toPublicModelKey((await repo.getModelKey(g.orgId!, key.id))!), requestId);
        },
      ],
      [
        "DELETE",
        KEY_RE,
        async (m) => {
          const g = await gate(m[1]);
          if (g.denied) return g.denied;
          const id = parsePublicId(m[2], "lpk");
          const removed = id ? await repo.deleteModelKey(g.orgId!, id) : null;
          return removed ? ok({ id: m[2], deleted: true }, requestId) : notFound(requestId);
        },
      ],
    ],
    requestId,
  );
}
