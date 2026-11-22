# agent-runtime-worker — architecture

1. **POST /internal/turn** (from slack-gateway) → the thread's ThreadAgent: the turn is inserted into the object's `turns` FIFO (deduped on the Slack event ts) and an alarm is set; the call returns 202 at once.
2. **alarm()** drains up to 10 turns in order: decrypt the installation's bot token (vault), load the config (first turn pins it: stage → draft, prod → published), read the thread from Slack once on a cold start, post a placeholder with the bot's name/icon (chat:write.customize), stream text into it with chat.update every ~1.2 s, run the loop (engine.ts → @saas/agent-core runAgent with the bot's compiled grants), write the final reply, store both messages, compact past 40 messages into a bounded digest.
3. **engine.runTurn** records agent_runs + agent_run_steps (redacted I/O), usage (agent_runs, agent_tokens_in/out, agent_tool_calls) and a bot.run.completed audit event.
4. **POST /internal/playground** (from bots-worker) runs the same engine on the draft config without Slack.

Idle threads delete their storage 30 days after the last turn (alarm).
