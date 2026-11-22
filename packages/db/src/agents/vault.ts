import type { AgentsRepository, SecretPurpose } from "./repository.js";

// THE VAULT. Envelope encryption with WebCrypto AES-256-GCM: every org has
// one data key (DEK), created on first use and stored wrapped by the platform
// key-encryption key (KEK, the VAULT_KEK_V<n> Worker secret, base64 32
// bytes). A secret is encrypted under its org's DEK. Only the Workers that
// hold the KEK can unwrap: config-worker (to store), agent-runtime-worker and
// slack-gateway-worker (to use). Plaintext never leaves the call that needs
// it, and nothing here logs.

const b64 = (bytes: ArrayBuffer | Uint8Array) => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
};
type AesKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
type Usage = "encrypt" | "decrypt";

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export interface KekRing {
  /** The version new DEKs are wrapped under. */
  current: number;
  /** base64 32-byte keys by version. */
  keys: Record<number, string>;
}

/** Read VAULT_KEK_V1.. from a Worker env into a ring. */
export function kekRingFromEnv(env: Record<string, unknown>): KekRing | null {
  const keys: Record<number, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(/^VAULT_KEK_V(\d+)$/);
    if (m && typeof v === "string" && v) keys[Number(m[1])] = v;
  }
  const versions = Object.keys(keys).map(Number);
  if (versions.length === 0) return null;
  return { current: Math.max(...versions), keys };
}

async function aesKey(raw: Uint8Array, usages: Usage[]): Promise<AesKey> {
  if (raw.byteLength !== 32) throw new Error("vault: a key must be 32 bytes");
  return crypto.subtle.importKey("raw", raw as unknown as ArrayBuffer, { name: "AES-GCM" }, false, usages);
}

async function seal(key: AesKey, plaintext: Uint8Array, aad: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) as unknown as ArrayBuffer }, key, plaintext as unknown as ArrayBuffer);
  return { ciphertext: b64(ct), iv: b64(iv) };
}

async function open(key: AesKey, ciphertext: string, iv: string, aad: string): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) as unknown as ArrayBuffer, additionalData: new TextEncoder().encode(aad) as unknown as ArrayBuffer }, key, unb64(ciphertext) as unknown as ArrayBuffer);
  return new Uint8Array(pt);
}

export function createVault(repo: AgentsRepository, ring: KekRing) {
  async function dekFor(orgId: string): Promise<AesKey> {
    let row = await repo.getOrgKey(orgId);
    if (!row) {
      const kek = await aesKey(unb64(ring.keys[ring.current]!), ["encrypt"]);
      const dek = crypto.getRandomValues(new Uint8Array(32));
      const wrapped = await seal(kek, dek, `dek:${orgId}`);
      row = await repo.insertOrgKey({ orgId, dekWrapped: wrapped.ciphertext, dekIv: wrapped.iv, kekVersion: ring.current });
    }
    const kekRaw = ring.keys[row.kekVersion];
    if (!kekRaw) throw new Error(`vault: KEK v${row.kekVersion} is not configured`);
    const kek = await aesKey(unb64(kekRaw), ["decrypt"]);
    const dek = await open(kek, row.dekWrapped, row.dekIv, `dek:${orgId}`);
    return aesKey(dek, ["encrypt", "decrypt"]);
  }

  return {
    /** Encrypt and store; returns the vault id. The value is never returned. */
    async put(orgId: string, purpose: SecretPurpose, value: string): Promise<string> {
      const dek = await dekFor(orgId);
      const sealed = await seal(dek, new TextEncoder().encode(value), `secret:${orgId}:${purpose}`);
      return repo.insertSecret({ orgId, purpose, ...sealed });
    },
    /** Decrypt for use in this call only. */
    async get(orgId: string, id: string): Promise<string | null> {
      const row = await repo.getSecret(orgId, id);
      if (!row) return null;
      const dek = await dekFor(orgId);
      return new TextDecoder().decode(await open(dek, row.ciphertext, row.iv, `secret:${orgId}:${row.purpose}`));
    },
    async remove(orgId: string, id: string): Promise<void> {
      await repo.deleteSecret(orgId, id);
    },
  };
}

export type Vault = ReturnType<typeof createVault>;

/** The last four characters a UI may show. */
export const last4 = (value: string) => value.slice(-4);
