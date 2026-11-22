# Waiting on a human

Steps an agent cannot take. Each says what to do and the signal the agent
checks for before it carries on.

## Open

### Sign-in to agentdesk (owner)

- **Why:** nobody can sign in yet. Magic-link email is sent by Cloudflare
  Email Service from `no-reply@mail.agentdesk.example.com`, an unverified
  placeholder domain, and no OAuth provider has credentials. Every console
  page and authenticated API needs a session.
- **Pick one (or both):**
  1. **GitHub sign-in:** github.com → Settings → Developer settings → OAuth
     Apps → New. Callback URL
     `https://agentdesk-api-edge-stage.openproduct.workers.dev/v1/auth/oauth/github/callback`
     (and `…-prod…` for a second app). Store `GITHUB_OAUTH_CLIENT_SECRET`
     with `orun secrets set … --env stage` (value on stdin) and the client id
     where `apps/identity-worker/wrangler.template.jsonc` reads it.
  2. **Email:** a domain you own, onboarded to Cloudflare Email Service;
     set `EMAIL_FROM_ADDRESS` in `apps/notifications-worker` to it.
- **Unblock signal:** signing in to
  `https://agentdesk-web-console-next-stage.openproduct.workers.dev` reaches
  the org page; the agent then verifies the playground and runs end to end.


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
