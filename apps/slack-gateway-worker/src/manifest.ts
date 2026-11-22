import { SHARED_SCOPES } from "./admin.js";
import type { Env } from "./env.js";

// The shared app's Slack manifest, served at /slack/manifest.json so an
// admin can paste it into api.slack.com → "Create New App → From a manifest".
// (A per-bot BYO manifest generator follows in AD3.)
export function manifest(env: Env, host: string) {
  const base = `https://${env.PUBLIC_HOST ?? host}`;
  const name = env.ENVIRONMENT === "prod" ? "agentdesk" : `agentdesk (${env.ENVIRONMENT})`;
  return {
    display_information: {
      name,
      description: "AI agents for your team, built in agentdesk.",
      background_color: "#1f2937",
    },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: "agentdesk", always_online: true },
      slash_commands: [
        { command: "/agent", url: `${base}/slack/commands`, description: "Ask one of your agentdesk bots", usage_hint: "<bot> <question>", should_escape: false },
      ],
    },
    oauth_config: {
      redirect_urls: [`${base}/slack/oauth/callback`],
      scopes: { bot: SHARED_SCOPES },
    },
    settings: {
      event_subscriptions: {
        request_url: `${base}/slack/events`,
        bot_events: ["app_mention", "message.im", "message.channels", "message.groups", "app_uninstalled", "tokens_revoked"],
      },
      interactivity: { is_enabled: true, request_url: `${base}/slack/interactivity` },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
