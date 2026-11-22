-- 200_agents_foundation: agentdesk's AI agent bots persistence (AD1, AD-2).
--
-- Context: agents
-- Epic: agentdesk-agent-bots (AD1) — one Cirrus project is one bot. This
--       migration lands every table the four new bounded contexts read:
--       bots (profiles, versioned configs), slack (installations, bindings),
--       models (BYOK keys), connectors (MCP servers, grants, user tokens),
--       the vault (per-org data keys, envelope-encrypted secrets) and runs.
--
-- Design rules (specs/epics/agentdesk-agent-bots/design.md §1–§2):
--   * Every tenant-owned row carries org_id TEXT NOT NULL (and project_id
--     where it applies); every repository query filters on it.
--   * A published config version is immutable: the repository refuses an
--     update to a row whose status is not 'draft'.
--   * Secret VALUES live only in vault_secrets as AES-256-GCM ciphertext
--     under the org's data key; every other table points at a vault id.
--   * Keyset pagination indexes (org_id, …, created_at DESC, id DESC).
--   * Idempotent: IF NOT EXISTS throughout for re-apply safety.

-- ── Vault ──────────────────────────────────────────────────
-- One data-encryption key (DEK) per org, wrapped by the platform KEK named
-- by kek_version (VAULT_KEK_V<n> Worker secret).
CREATE TABLE IF NOT EXISTS vault_org_keys (
  org_id        TEXT PRIMARY KEY,
  dek_wrapped   TEXT NOT NULL,             -- base64 AES-GCM(KEK, DEK)
  dek_iv        TEXT NOT NULL,             -- base64 12-byte IV
  kek_version   INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rotated_at    TEXT
);

CREATE TABLE IF NOT EXISTS vault_secrets (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  org_id        TEXT NOT NULL,
  purpose       TEXT NOT NULL
                  CHECK (purpose IN ('llm_key', 'slack_bot_token', 'slack_signing_secret', 'mcp_token', 'mcp_oauth', 'tool_key')),
  ciphertext    TEXT NOT NULL,             -- base64 AES-GCM(DEK, value)
  iv            TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rotated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_vault_secrets_org ON vault_secrets (org_id, created_at DESC, id DESC);

-- ── Model keys (BYOK) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS llm_provider_keys (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  org_id            TEXT NOT NULL,
  provider          TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic', 'google', 'openai-compatible', 'exa')),
  label             TEXT NOT NULL,
  base_url          TEXT,
  secret_id         TEXT NOT NULL,         -- vault_secrets.id
  last4             TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'valid', 'invalid')),
  last_verified_at  TEXT,
  created_by        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_llm_provider_keys_org ON llm_provider_keys (org_id, created_at DESC, id DESC);

-- ── Bots ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bots_profiles (
  project_id    TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  description   TEXT,
  avatar_url    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_bots_profiles_org ON bots_profiles (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bots_config_versions (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  org_id            TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  version           INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'superseded')),
  system_prompt     TEXT NOT NULL DEFAULT '',
  model_ref         TEXT NOT NULL DEFAULT 'workers-ai:@cf/moonshotai/kimi-k2.6',
  provider_key_id   TEXT,                  -- llm_provider_keys.id for BYOK
  params_json       TEXT NOT NULL DEFAULT '{}',
  tool_grants_json  TEXT NOT NULL DEFAULT '[]',  -- snapshot of the grants at publish
  policy_ref        TEXT NOT NULL DEFAULT 'builtin:v1',
  created_by        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  published_at      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bots_config_versions_version ON bots_config_versions (project_id, version);
-- At most one draft and one published version per bot.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bots_config_versions_draft ON bots_config_versions (project_id) WHERE status = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS uq_bots_config_versions_published ON bots_config_versions (project_id) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_bots_config_versions_org ON bots_config_versions (org_id, project_id, version DESC);

-- ── Slack ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS slack_installations (
  api_app_id           TEXT NOT NULL,
  team_id              TEXT NOT NULL,
  org_id               TEXT NOT NULL,
  enterprise_id        TEXT,
  team_name            TEXT,
  mode                 TEXT NOT NULL DEFAULT 'shared' CHECK (mode IN ('shared', 'byo')),
  project_id           TEXT,               -- set for a BYO app (one bot)
  bot_user_id          TEXT,
  bot_token_secret_id  TEXT,               -- vault_secrets.id
  signing_secret_id    TEXT,               -- vault_secrets.id (BYO only)
  scopes               TEXT,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  installed_by         TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (api_app_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_slack_installations_org ON slack_installations (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS slack_bindings (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  org_id      TEXT NOT NULL,
  team_id     TEXT NOT NULL,
  channel_id  TEXT NOT NULL DEFAULT '',    -- '' = the bot's DMs
  project_id  TEXT NOT NULL,
  env         TEXT NOT NULL DEFAULT 'prod' CHECK (env IN ('stage', 'prod')),
  trigger     TEXT NOT NULL DEFAULT 'mention' CHECK (trigger IN ('mention', 'all', 'command', 'dm')),
  command_slug TEXT,                       -- /agent <slug>
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_slack_bindings_route ON slack_bindings (team_id, channel_id, trigger);
CREATE UNIQUE INDEX IF NOT EXISTS uq_slack_bindings_command ON slack_bindings (team_id, command_slug) WHERE command_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_slack_bindings_project ON slack_bindings (org_id, project_id);

-- ── Connectors (MCP) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS connectors_servers (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  org_id            TEXT NOT NULL,
  name              TEXT NOT NULL,          -- slug used in tool names: mcp__<name>__<tool>
  url               TEXT NOT NULL,
  transport         TEXT NOT NULL DEFAULT 'streamable-http' CHECK (transport IN ('streamable-http', 'sse')),
  auth_type         TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'oauth', 'user-oauth')),
  secret_id         TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'disabled')),
  tools_cache_json  TEXT NOT NULL DEFAULT '[]',
  tools_synced_at   TEXT,
  last_error        TEXT,
  created_by        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_connectors_servers_name ON connectors_servers (org_id, name);
CREATE INDEX IF NOT EXISTS idx_connectors_servers_org ON connectors_servers (org_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS connectors_grants (
  id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  org_id                TEXT NOT NULL,
  project_id            TEXT NOT NULL,
  server_id             TEXT NOT NULL,      -- connectors_servers.id, or 'builtin'
  tool_name             TEXT NOT NULL,      -- a tool name, or '*'
  mode                  TEXT NOT NULL CHECK (mode IN ('allow', 'approve', 'deny')),
  arg_constraints_json  TEXT,
  description_hash      TEXT,               -- the tool description the admin approved
  created_by            TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_connectors_grants_tool ON connectors_grants (project_id, server_id, tool_name);
CREATE INDEX IF NOT EXISTS idx_connectors_grants_org ON connectors_grants (org_id, project_id);

CREATE TABLE IF NOT EXISTS connectors_user_tokens (
  org_id         TEXT NOT NULL,
  server_id      TEXT NOT NULL,
  slack_user_id  TEXT NOT NULL,
  secret_id      TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (server_id, slack_user_id)
);

-- ── Runs ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_runs (
  id                 TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  org_id             TEXT NOT NULL,
  project_id         TEXT NOT NULL,
  config_version_id  TEXT,
  env                TEXT NOT NULL DEFAULT 'prod',
  source             TEXT NOT NULL DEFAULT 'slack' CHECK (source IN ('slack', 'playground', 'api')),
  team_id            TEXT,
  channel_id         TEXT,
  thread_ts          TEXT,
  slack_user_id      TEXT,
  model              TEXT,
  status             TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'suspended')),
  tokens_in          INTEGER NOT NULL DEFAULT 0,
  tokens_out         INTEGER NOT NULL DEFAULT 0,
  cost_micros        INTEGER NOT NULL DEFAULT 0,
  latency_ms         INTEGER,
  error              TEXT,
  started_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_project ON agent_runs (org_id, project_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_org ON agent_runs (org_id, started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS agent_run_steps (
  run_id            TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  org_id            TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('llm', 'tool', 'approval')),
  tool              TEXT,
  policy_decision   TEXT CHECK (policy_decision IN ('allow', 'deny', 'approve')),
  duration_ms       INTEGER,
  redacted_io_json  TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (run_id, seq)
);
