# connectors-worker — runbook

- **Add fails with connector_unreachable:** the server did not answer initialize/tools/list over Streamable HTTP within 15 s, or refused the token (401/403).
- **A tool vanished from a bot:** its description changed since it was granted; check POST …/connectors/{id}/sync's changedTools and re-grant it.
- **429 Too many concurrent tool calls:** more than 8 in flight for one org's connector.
