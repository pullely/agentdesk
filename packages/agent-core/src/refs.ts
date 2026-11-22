// The vocabulary of a bot's config, free of the AI SDK so the config surface
// (bots-worker) can validate without bundling providers.

export const DEFAULT_MODEL_REF = "workers-ai:@cf/moonshotai/kimi-k2.6";

// Workers AI models allowed as a bot's model: the ones that call tools well.
export const WORKERS_AI_MODELS = [
  "@cf/moonshotai/kimi-k2.6",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/openai/gpt-oss-120b",
] as const;

export type Provider = "workers-ai" | "openai" | "anthropic" | "openai-compatible";

export interface ModelRef {
  provider: Provider;
  id: string;
}

export function parseModelRef(ref: string | null | undefined): ModelRef {
  const value = ref && ref.includes(":") ? ref : DEFAULT_MODEL_REF;
  const i = value.indexOf(":");
  const provider = value.slice(0, i) as Provider;
  const id = value.slice(i + 1);
  if (!["workers-ai", "openai", "anthropic", "openai-compatible"].includes(provider) || !id) {
    throw new Error(`unsupported model ref: ${value}`);
  }
  if (provider === "workers-ai" && !(WORKERS_AI_MODELS as readonly string[]).includes(id)) {
    throw new Error(`Workers AI model not allowed: ${id}`);
  }
  return { provider, id };
}

export const BUILTIN_SERVER_ID = "builtin";

export const BUILTIN_TOOL_NAMES = ["getWeather", "throwDice", "searchWeb", "bash", "readFile", "writeFile"] as const;
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export const BUILTIN_TOOL_DESCRIPTIONS: Record<BuiltinToolName, string> = {
  getWeather: "Get the current weather for a city (Open-Meteo).",
  throwDice: "Roll a six-sided die.",
  searchWeb: "Search the web with Exa (needs the org's Exa key).",
  bash: "Run one simple shell command in an in-memory sandbox (no network, no host access).",
  readFile: "Read a file from the in-memory sandbox.",
  writeFile: "Write a file in the in-memory sandbox (denied by policy: bots are read-only).",
};

/** The name the model sees for an MCP tool: mcp__<server name>__<tool>. */
export function mcpToolName(serverName: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__${clean(serverName)}__${clean(tool)}`.slice(0, 64);
}

/** Server names are slugs: they appear in tool names. */
export const SERVER_NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
