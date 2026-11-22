# agent-runtime-worker — runbook

- **/health** names the default model, the gateway, and whether the vault key, ThreadAgent and connectors are bound.
- **A Slack thread never answers:** check the run list in the console; a run with status failed carries the error (missing model key, vault not configured, policy load).
- **A thread answers on an old config:** threads pin the version they started on; start a new thread after publishing.
- **Reset a thread:** its state is in the ThreadAgent named org:project:team:channel:thread_ts; it expires after 30 idle days.
