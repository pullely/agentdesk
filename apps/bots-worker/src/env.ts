export interface Env {
  ENVIRONMENT: string;
  PLATFORM_DB?: D1Database;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  /** agent-runtime-worker: runs the playground on the draft config (AD-4). */
  AGENT_RUNTIME?: Fetcher;
}
