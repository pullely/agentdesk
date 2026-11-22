export interface Env {
  ENVIRONMENT: string;
  PLATFORM_DB?: D1Database;
  /** Workers AI — the default model provider. */
  AI?: Ai;
  /** One ThreadAgent per org:project:team:channel:thread_ts. */
  THREAD_AGENT?: DurableObjectNamespace;
  /** connectors-worker: MCP tool discovery and calls (AD-6). */
  CONNECTORS_WORKER?: Fetcher;
  /** The AI Gateway every model call goes through (agentdesk-<env>). */
  AI_GATEWAY_ID?: string;
  /** Cloudflare account id, for BYOK calls through AI Gateway. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Vault key-encryption keys (base64, 32 bytes). */
  VAULT_KEK_V1?: string;
  VAULT_KEK_V2?: string;
  /** TEST ONLY — where the Slack Web API is. */
  SLACK_API_URL?: string;
}
