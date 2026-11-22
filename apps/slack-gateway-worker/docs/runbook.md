# slack-gateway-worker — runbook

- **/health** says whether the shared app is configured (SLACK_SIGNING_SECRET), OAuth is ready, the vault key and the runtime are bound.
- **Slack shows 'Your URL didn't respond with the challenge':** SLACK_SIGNING_SECRET is unset or wrong for this environment — url_verification is verified like every request.
- **Events arrive, nobody answers:** the channel has no binding for that trigger (Channels tab), or the installation is revoked; runs for the bot show in the console.
- **Create the shared app:** api.slack.com → Create New App → From a manifest → paste https://agentdesk-slack-gateway-worker-<env>.openproduct.workers.dev/slack/manifest.json; then set SLACK_APP_ID, SLACK_SIGNING_SECRET, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET with `orun secrets set <KEY> --env <env>` (value on stdin) and redeploy.
