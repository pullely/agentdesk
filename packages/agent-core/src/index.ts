// @saas/agent-core — the agent loop agentdesk's runtime and playground share.
// Ported from sourceplane/ai-slackbot baseline-v3 (MIT, from
// vercel-labs/ai-sdk-slackbot); see NOTICE.
export * from "./agent";
export * from "./model";
export { BUILTIN_SERVER_ID, mcpToolName, SERVER_NAME_RE } from "./refs";
export * from "./prompt";
export * from "./slack";
export * from "./ssrf";
export * from "./tools/builtins";
export { loadToolApproval, policyClient, toInput } from "./policy/load";
