# slack-gateway-worker — architecture

**Every Slack request:** raw body → (api_app_id, team_id) → the installation → that app's signing secret (shared: Worker secret; BYO: vault) → HMAC v0 check, ±5 min (WebCrypto, ported from ai-slackbot) → only then parse. Retries (X-Slack-Retry-Num) are acked with X-Slack-No-Retry. Bots, the bot itself and message subtypes are ignored.

**Routing:** app_mention → the channel's mention binding; message.im → the team's DM binding; message.channels → an 'all' binding; a BYO app is one bot. **/agent <slug> <question>** posts the question as a thread root and hands that thread to the bot bound to the slug.

**Hand-off:** POST AGENT_RUNTIME /internal/turn → the thread's ThreadAgent persists the turn (deduped on the event ts) and returns; the gateway acks Slack (<3 s budget, a slow hand-off continues in waitUntil).

**Install:** POST /v1/organizations/{org}/slack/install-url returns Slack's authorize URL with an HMAC-signed, 10-minute state carrying the org; /slack/oauth/callback exchanges the code, stores the bot token in the vault and the installation as mode shared. POST …/slack/installations registers an app directly (a BYO app: its own signing secret, one bot). app_uninstalled / tokens_revoked revoke the installation and delete its token.

**Manifest:** GET /slack/manifest.json is the shared app's manifest for api.slack.com.
