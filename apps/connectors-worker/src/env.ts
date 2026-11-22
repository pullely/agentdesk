export interface Env {
  ENVIRONMENT: string;
  PLATFORM_DB?: D1Database;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  /** One McpSession per org:server. */
  MCP_SESSION?: DurableObjectNamespace;
  /** Vault key-encryption keys (bearer tokens). */
  VAULT_KEK_V1?: string;
  VAULT_KEK_V2?: string;
}
