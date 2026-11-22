// Verify a BYOK key on save — kept free of the AI SDK so config-worker can
// import it without bundling the providers.
export interface VerifiableKey {
  provider: "openai" | "anthropic" | "google" | "openai-compatible" | "exa";
  apiKey: string;
  baseUrl?: string | null;
}

/**
 * Verify a BYOK key on save with the cheapest call the provider has: list its
 * models. Answers true/false and never echoes the key.
 */
export async function verifyProviderKey(
  key: VerifiableKey,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  let url: string;
  const headers: Record<string, string> = {};
  if (key.provider === "exa") {
    url = "https://api.exa.ai/search";
    headers["x-api-key"] = key.apiKey;
    headers["content-type"] = "application/json";
    try {
      const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify({ query: "ping", numResults: 1 }) });
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }
  if (key.provider === "google") {
    url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1`;
    headers["x-goog-api-key"] = key.apiKey;
  } else if (key.provider === "anthropic") {
    url = "https://api.anthropic.com/v1/models?limit=1";
    headers["x-api-key"] = key.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    const base = key.provider === "openai" ? "https://api.openai.com/v1" : (key.baseUrl ?? "").replace(/\/$/, "");
    if (!base) return { ok: false, status: 0 };
    url = `${base}/models`;
    headers.authorization = `Bearer ${key.apiKey}`;
  }
  try {
    const res = await fetchImpl(url, { headers });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
