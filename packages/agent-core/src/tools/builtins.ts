import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { untrusted } from "../prompt";

// The built-in tools, ported from sourceplane/ai-slackbot's run-agent.ts
// (getWeather, throwDice, searchWeb, the just-bash sandbox). In agentdesk
// they are the server named `builtin` in the grant model: a bot gets only
// the ones it is granted, and the OPA policy still applies upstream's safety
// rules to bash and the file tools.

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

export type SearchWeb = (
  query: string,
  specificDomain: string | null,
) => Promise<{ title: string | null; url: string; snippet: string }[]>;

/** Exa web search, built only when the org stored an Exa key. */
export function exaSearch(apiKey: string | undefined | null): SearchWeb | undefined {
  if (!apiKey) return undefined;
  return async (query, specificDomain) => {
    const { default: Exa } = await import("exa-js");
    const exa = new Exa(apiKey);
    const { results } = await exa.searchAndContents(query, {
      livecrawl: "always",
      numResults: 3,
      ...(specificDomain ? { includeDomains: [specificDomain] } : {}),
    });
    return results.map((r: { title: string | null; url: string; text: string }) => ({
      title: r.title,
      url: r.url,
      snippet: r.text.slice(0, 1000),
    }));
  };
}

let bashToolsPromise: Promise<Record<string, unknown>> | undefined;

/** bash/readFile/writeFile over just-bash, built once per isolate. */
export function getBashTools(): Promise<Record<string, unknown>> {
  if (!bashToolsPromise) {
    bashToolsPromise = import("bash-tool")
      .then(({ createBashTool }) =>
        createBashTool({
          files: {
            "README.md": "# Sandbox\n\nAn in-memory workspace for this agent.\n",
            "notes.txt": "line one\nline two\nline three\n",
          },
        }),
      )
      .then((r: { tools: Record<string, unknown> }) => r.tools);
    bashToolsPromise.catch(() => {
      bashToolsPromise = undefined;
    });
  }
  return bashToolsPromise;
}

export async function builtinTools(opts: {
  granted: string[];
  searchWeb?: SearchWeb;
  fetchImpl?: typeof fetch;
  onStatus?: (status: string) => void;
}): Promise<ToolSet> {
  const want = new Set(opts.granted);
  const f = opts.fetchImpl ?? fetch;
  const tools: ToolSet = {};

  if (want.has("getWeather")) {
    tools.getWeather = tool({
      description: "Get the current weather for a city. Only requires the city name — coordinates are looked up server-side.",
      inputSchema: z.object({ city: z.string().describe("City name only, e.g. 'San Francisco'.") }),
      execute: async ({ city }) => {
        opts.onStatus?.(`is getting weather for ${city}...`);
        const geo = (await f(
          `https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`,
        ).then((r) => r.json())) as { results?: { latitude: number; longitude: number }[] };
        const hit = geo?.results?.[0];
        if (!hit) return { error: `Could not geocode "${city}".`, city };
        const w = (await f(
          `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&current=temperature_2m,weathercode,relativehumidity_2m&timezone=auto`,
        ).then((r) => r.json())) as { current: Record<string, number> };
        return {
          temperature: w.current.temperature_2m,
          weatherCode: w.current.weathercode,
          humidity: w.current.relativehumidity_2m,
          city,
        };
      },
    });
  }

  if (want.has("throwDice")) {
    tools.throwDice = tool({
      description: "Roll a six-sided die and return a number between 1 and 6",
      inputSchema: z.object({}),
      execute: async () => {
        opts.onStatus?.("is rolling a die...");
        return { roll: Math.floor(Math.random() * 6) + 1 };
      },
    });
  }

  if (want.has("searchWeb") && opts.searchWeb) {
    const search = opts.searchWeb;
    tools.searchWeb = tool({
      description: "Use this to search the web for information",
      inputSchema: z.object({
        query: z.string(),
        specificDomain: z
          .string()
          .nullable()
          .describe("a domain to search if the user specifies e.g. bbc.com. Only the domain name, without the protocol"),
      }),
      execute: async ({ query, specificDomain }) => {
        opts.onStatus?.(`is searching the web for ${query}...`);
        return untrusted({ results: await search(query, specificDomain) });
      },
    });
  }

  if (want.has("bash") || want.has("readFile") || want.has("writeFile")) {
    const bash = await getBashTools();
    for (const name of ["bash", "readFile", "writeFile"] as const) {
      if (want.has(name) && bash[name]) tools[name] = bash[name] as ToolSet[string];
    }
  }
  return tools;
}
