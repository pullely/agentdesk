import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";

// THE MODEL ROUTER. One function turns a bot's `model_ref` and, for BYOK, its
// decrypted key into an AI SDK LanguageModel, so the agent loop never knows
// which provider it is talking to. Every provider call goes through the
// environment's Cloudflare AI Gateway (logs, caching, per-org rate limits),
// tagged with the org, project and run.
//
import { parseModelRef, type Provider } from "./refs";

export { DEFAULT_MODEL_REF, WORKERS_AI_MODELS, parseModelRef, type ModelRef, type Provider } from "./refs";

export interface GatewayConfig {
  /** Cloudflare account id the gateway lives in. */
  accountId?: string;
  /** Gateway name, one per environment (agentdesk-stage, agentdesk-prod). */
  gatewayId?: string;
}

export interface ByokKey {
  provider: Exclude<Provider, "workers-ai">;
  apiKey: string;
  baseUrl?: string | null;
}

export interface ResolveModelInput {
  modelRef: string | null | undefined;
  /** The Worker's Workers AI binding. */
  ai?: unknown;
  gateway?: GatewayConfig;
  /** The decrypted BYOK key, for a non-Workers-AI model. Never logged. */
  key?: ByokKey | null;
  /** cf-aig-metadata: who this call is for. */
  metadata?: Record<string, string>;
}

export interface ResolvedModel {
  model: LanguageModel;
  provider: Provider;
  id: string;
  billing: "platform" | "byok";
}

function gatewayBase(g?: GatewayConfig): string | null {
  if (!g?.accountId || !g.gatewayId) return null;
  return `https://gateway.ai.cloudflare.com/v1/${g.accountId}/${g.gatewayId}`;
}

export function resolveModel(input: ResolveModelInput): ResolvedModel {
  const ref = parseModelRef(input.modelRef);
  const headers: Record<string, string> = {};
  if (input.metadata) headers["cf-aig-metadata"] = JSON.stringify(input.metadata);
  const base = gatewayBase(input.gateway);

  if (ref.provider === "workers-ai") {
    if (!input.ai) throw new Error("Workers AI binding is missing");
    const workersAi = createWorkersAI({
      binding: input.ai as never,
      ...(input.gateway?.gatewayId
        ? { gateway: { id: input.gateway.gatewayId, metadata: input.metadata } as never }
        : {}),
    });
    return { model: workersAi(ref.id as never), provider: ref.provider, id: ref.id, billing: "platform" };
  }

  const key = input.key;
  if (!key || !key.apiKey) throw new Error(`no ${ref.provider} key is stored for this bot`);
  if (key.provider !== ref.provider) {
    throw new Error(`the bot's key is for ${key.provider}, its model is ${ref.provider}`);
  }

  if (ref.provider === "openai") {
    const openai = createOpenAI({
      apiKey: key.apiKey,
      ...(base ? { baseURL: `${base}/openai` } : {}),
      headers,
    });
    return { model: openai.chat(ref.id), provider: ref.provider, id: ref.id, billing: "byok" };
  }
  if (ref.provider === "anthropic") {
    const anthropic = createAnthropic({
      apiKey: key.apiKey,
      ...(base ? { baseURL: `${base}/anthropic/v1` } : {}),
      headers,
    });
    return { model: anthropic(ref.id), provider: ref.provider, id: ref.id, billing: "byok" };
  }
  // OpenAI-compatible: the key's own base URL (Groq, Together, OpenRouter…).
  if (!key.baseUrl) throw new Error("an OpenAI-compatible key needs a base URL");
  const compat = createOpenAI({ apiKey: key.apiKey, baseURL: key.baseUrl, headers });
  return { model: compat.chat(ref.id), provider: ref.provider, id: ref.id, billing: "byok" };
}

export { verifyProviderKey } from "./verify";
