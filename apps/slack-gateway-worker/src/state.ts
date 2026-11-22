// Signed, expiring OAuth state: base64url(JSON) + "." + HMAC-SHA256. The
// tenancy keystone of the install flow — the org comes from our signature,
// never from what Slack redirects back.

const enc = new TextEncoder();
const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function mac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

export interface OAuthState {
  orgId: string;
  actor: string;
  returnTo: string | null;
  exp?: number;
  nonce?: string;
}

export async function signState(secret: string, state: OAuthState, ttlSeconds = 600): Promise<string> {
  const payload = b64u(enc.encode(JSON.stringify({ ...state, exp: Math.floor(Date.now() / 1000) + ttlSeconds, nonce: crypto.randomUUID() })));
  return `${payload}.${await mac(secret, payload)}`;
}

export async function verifyState(secret: string, token: string): Promise<OAuthState | null> {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = await mac(secret, payload);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(unb64u(payload))) as OAuthState;
    if (!s.exp || s.exp < Math.floor(Date.now() / 1000)) return null;
    return s;
  } catch {
    return null;
  }
}
