# Waiting on a human

Steps an agent cannot take. Each says what to do and the signal the agent
checks for before it carries on.

## Open

### Create the shared Slack app (owner)

- **Why:** a Slack app is created by a person signed in to Slack. Until it
  exists, the gateway answers `slack_not_configured` for the shared app.
  A registered (bring-your-own) app works now: Agents → Slack → Register an app.
- **Steps, once per environment (stage, then prod):**
  1. api.slack.com → **Create New App** → **From a manifest** → choose the
     workspace → paste the JSON from
     `https://agentdesk-slack-gateway-worker-stage.openproduct.workers.dev/slack/manifest.json`
     (prod: `…-prod…`).
  2. From **Basic Information**, store four values as orun secrets, with each
     value on stdin, never on the command line:
     `orun secrets set SLACK_APP_ID --env stage`,
     `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`.
  3. Re-run the gateway's deploy (Orunbase → Deploy → slack-gateway-worker, or
     any merge that touches it).
  4. In Slack's **Event Subscriptions**, the request URL verifies, and it
     answers the challenge only when the signing secret matches.
- **Unblock signal:** `GET …-slack-gateway-worker-stage…/health` reports
  `"slack": "configured"` and `"oauth": true`; "Add to Slack" in the console
  completes.
