export interface Env {
  ENVIRONMENT: string;
  /** This Worker's public host (Slack's request URLs and the OAuth redirect). */
  PUBLIC_HOST?: string;
  PLATFORM_DB?: D1Database;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  /** agent-runtime-worker: POST /internal/turn → the thread's ThreadAgent. */
  AGENT_RUNTIME?: Fetcher;
  /** The shared app (runtime secrets, set once the app exists in Slack). */
  SLACK_APP_ID?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  /** Signs the install flow's state; generated on first deploy. */
  OAUTH_STATE_SECRET?: string;
  /** Vault key-encryption keys. */
  VAULT_KEK_V1?: string;
  VAULT_KEK_V2?: string;
  /** TEST ONLY — where the Slack Web API is. */
  SLACK_API_URL?: string;
}
