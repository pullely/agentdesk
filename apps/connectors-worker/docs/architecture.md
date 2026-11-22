# connectors-worker — architecture

- **Add:** SSRF guard (https only; no private, loopback, link-local, CGNAT or IPv6-local literals; no internal hostnames; not agentdesk's own Workers) → initialize + tools/list (a server that does not answer is not added) → bearer token into the vault → row + tool cache. Server names are slugs; the model sees tool `t` on server `docs` as `mcp__docs__t`.
- **Sync:** re-lists tools and reports which descriptions changed. A grant records the description hash the admin approved; agent-runtime stops offering a tool whose description changed until it is re-granted (tool-poisoning guard).
- **Call:** agent-runtime → POST /internal/call → re-checks a non-deny grant for that bot → the org:server McpSession, which holds the MCP session id and the decrypted bearer in memory, reconnects once on an expired session, caps 8 concurrent calls, and times out at 15 s with a 1 MB response cap (the runtime truncates to 64 KB and marks it untrusted).
- The client is a minimal Streamable HTTP JSON-RPC client (MCP 2025-06-18) answering JSON or SSE.
