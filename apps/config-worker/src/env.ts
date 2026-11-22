export interface Env {
  PLATFORM_DB?: D1Database;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  ENVIRONMENT: string;
  /** Hex-encoded 256-bit key for secret payload encryption (AES-256-GCM). */
  SECRET_ENCRYPTION_KEY?: string;
  /** agentdesk vault key-encryption keys (base64, 32 bytes): VAULT_KEK_V1, V2… */
  VAULT_KEK_V1?: string;
  VAULT_KEK_V2?: string;
}
