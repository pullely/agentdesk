import { jest } from "@jest/globals";
import { tool } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { z } from "zod";
import {
  buildSystemPrompt,
  checkRemoteUrl,
  formatReply,
  isValidSlackRequest,
  parseModelRef,
  redactIo,
  renderTemplate,
  resolveModel,
  runAgent,
  slackSignature,
  stripMention,
  untrusted,
} from "@saas/agent-core";
import { realPolicy } from "./helpers";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const finish = (unified: string) => ({ type: "finish", finishReason: { unified, raw: unified }, usage });

function textTurn(text: string) {
  return {
    stream: convertArrayToReadableStream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      ...text.split(" ").map((w, i) => ({ type: "text-delta", id: "t", delta: (i ? " " : "") + w })),
      { type: "text-end", id: "t" },
      finish("stop"),
    ] as never[]),
  };
}

function toolTurn(toolName: string, input: unknown) {
  return {
    stream: convertArrayToReadableStream([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) },
      finish("tool-calls"),
    ] as never[]),
  };
}

/** A model that answers with the given turns in order. */
function scripted(turns: ReturnType<typeof textTurn>[]) {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: async () => turns[Math.min(i++, turns.length - 1)] as never,
  });
}

const ctx = (grants: Record<string, { mode: "allow" | "approve" | "deny"; argConstraints?: Record<string, string> }>) => ({
  orgId: "org_1",
  projectId: "prj_1",
  channelId: "C1",
  userId: "U1",
  grants,
});

describe("the compiled policy (policy.wasm under Node)", () => {
  let client: Awaited<ReturnType<typeof realPolicy>>["client"];
  beforeAll(async () => {
    ({ client } = await realPolicy());
  });
  const decide = (input: unknown) => client.evaluate("agent/call/decision", input) as Promise<unknown>;

  it("denies a tool no grant names", async () => {
    const d = (await decide({ tool: { name: "mcp__x__y" }, args: {}, runtimeContext: ctx({}) })) as never as Record<string, unknown>;
    expect(JSON.stringify(d)).toContain("not granted");
  });
  it("allows a granted MCP tool inside its constraints", async () => {
    const d = await decide({
      tool: { name: "mcp__gh__get" },
      args: { repo: "acme/web" },
      runtimeContext: ctx({ mcp__gh__get: { mode: "allow", argConstraints: { repo: "acme/*" } } }),
    });
    expect(JSON.stringify(d)).toContain('"allow"');
  });
  it("denies the same tool outside its constraints", async () => {
    const d = await decide({
      tool: { name: "mcp__gh__get" },
      args: { repo: "evil/web" },
      runtimeContext: ctx({ mcp__gh__get: { mode: "allow", argConstraints: { repo: "acme/*" } } }),
    });
    expect(JSON.stringify(d)).toContain("outside what this bot may use");
  });
  it("asks for approval on an approve grant", async () => {
    const d = await decide({ tool: { name: "mcp__gh__create" }, args: {}, runtimeContext: ctx({ mcp__gh__create: { mode: "approve" } }) });
    expect(JSON.stringify(d)).toContain("requires-approval");
  });
});

describe("runAgent — the ported loop", () => {
  it("streams text and reports no tools", async () => {
    const { approval } = await realPolicy();
    const seen: string[] = [];
    const r = await runAgent({
      model: scripted([textTurn("hello there friend")]),
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
      runtimeContext: ctx({}),
      toolApproval: approval,
      onText: (t) => {
        seen.push(t);
      },
    });
    expect(r.text).toBe("hello there friend");
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe("hello there friend");
    expect(r.outcomes).toEqual([]);
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(formatReply(r.text, r.outcomes)).toContain("🔧 none");
  });

  it("runs a granted tool and records the step", async () => {
    const { approval } = await realPolicy();
    const execute = jest.fn(async () => ({ hits: ["doc-1"] }));
    const r = await runAgent({
      model: scripted([toolTurn("mcp__docs__search", { q: "deploy" }), textTurn("found doc-1")]),
      system: "s",
      messages: [{ role: "user", content: "search" }],
      tools: { mcp__docs__search: tool({ description: "search", inputSchema: z.object({ q: z.string() }), execute }) },
      runtimeContext: ctx({ mcp__docs__search: { mode: "allow" } }),
      toolApproval: approval,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(r.outcomes).toEqual([{ toolName: "mcp__docs__search", status: "used" }]);
    expect(r.steps.some((s) => s.kind === "tool" && s.tool === "mcp__docs__search" && s.policyDecision === "allow")).toBe(true);
    expect(r.text).toBe("found doc-1");
  });

  it("never executes an ungranted tool, and says why", async () => {
    const { approval } = await realPolicy();
    const execute = jest.fn(async () => "should not run");
    const r = await runAgent({
      model: scripted([toolTurn("mcp__gh__delete_repo", { repo: "acme/web" }), textTurn("ok")]),
      system: "s",
      messages: [{ role: "user", content: "delete it" }],
      tools: { mcp__gh__delete_repo: tool({ description: "d", inputSchema: z.object({ repo: z.string() }), execute }) },
      runtimeContext: ctx({}),
      toolApproval: approval,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(r.outcomes[0]).toMatchObject({ toolName: "mcp__gh__delete_repo", status: "denied" });
    expect(formatReply(r.text, r.outcomes)).toContain("blocked by policy");
  });

  it("refuses an approve grant in AD1 (no approval flow yet)", async () => {
    const { approval } = await realPolicy();
    const execute = jest.fn(async () => "should not run");
    const r = await runAgent({
      model: scripted([toolTurn("mcp__gh__create_issue", { title: "x" }), textTurn("ok")]),
      system: "s",
      messages: [{ role: "user", content: "file it" }],
      tools: { mcp__gh__create_issue: tool({ description: "c", inputSchema: z.object({ title: z.string() }), execute }) },
      runtimeContext: ctx({ mcp__gh__create_issue: { mode: "approve" } }),
      toolApproval: approval,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(r.steps.some((s) => s.kind === "approval")).toBe(true);
    expect(r.outcomes[0]?.status).toBe("denied");
  });
});

describe("the model router", () => {
  it("defaults to Workers AI kimi-k2.6", () => {
    expect(parseModelRef(null)).toEqual({ provider: "workers-ai", id: "@cf/moonshotai/kimi-k2.6" });
  });
  it("refuses a Workers AI model off the allow-list", () => {
    expect(() => parseModelRef("workers-ai:@cf/some/untested")).toThrow(/not allowed/);
  });
  it("needs the AI binding for Workers AI", () => {
    expect(() => resolveModel({ modelRef: null })).toThrow(/binding/);
  });
  it("routes BYOK OpenAI and refuses a mismatched key", () => {
    const m = resolveModel({
      modelRef: "openai:gpt-4o",
      key: { provider: "openai", apiKey: "sk-test" },
      gateway: { accountId: "acc", gatewayId: "agentdesk-stage" },
    });
    expect(m).toMatchObject({ provider: "openai", id: "gpt-4o", billing: "byok" });
    expect(() => resolveModel({ modelRef: "anthropic:claude-x", key: { provider: "openai", apiKey: "k" } })).toThrow(/key is for openai/);
    expect(() => resolveModel({ modelRef: "anthropic:claude-x" })).toThrow(/no anthropic key/);
  });
});

describe("SSRF guard", () => {
  it.each([
    ["http://example.com/mcp", "https"],
    ["https://127.0.0.1/mcp", "private"],
    ["https://10.1.2.3/mcp", "private"],
    ["https://169.254.169.254/latest", "private"],
    ["https://192.168.1.4/", "private"],
    ["https://[::1]/", "private"],
    ["https://localhost/", "internal"],
    ["https://db.internal/", "internal"],
    ["https://u:p@example.com/", "credentials"],
    ["https://agentdesk-api-edge-prod.openproduct.workers.dev/", "own Workers"],
  ])("refuses %s", (url, why) => {
    const r = checkRemoteUrl(url, { ownWorkersDevPrefix: "agentdesk-" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(why);
  });
  it("allows a public https MCP URL", () => {
    expect(checkRemoteUrl("https://mcp.example.com/mcp").ok).toBe(true);
  });
});

describe("Slack signatures (ported)", () => {
  const secret = "test-signing-secret";
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  it("accepts a correct signature and refuses a forged one or a stale timestamp", async () => {
    const body = '{"type":"event_callback"}';
    const sig = await slackSignature(secret, ts, body);
    expect(await isValidSlackRequest({ signingSecret: secret, timestamp: ts, signature: sig, rawBody: body, now })).toBe(true);
    expect(await isValidSlackRequest({ signingSecret: secret, timestamp: ts, signature: sig, rawBody: body + " ", now })).toBe(false);
    expect(await isValidSlackRequest({ signingSecret: "other", timestamp: ts, signature: sig, rawBody: body, now })).toBe(false);
    expect(await isValidSlackRequest({ signingSecret: secret, timestamp: ts, signature: sig, rawBody: body, now: now + 600_000 })).toBe(false);
  });
  it("strips the bot mention", () => {
    expect(stripMention("<@B1> what's up", "B1")).toBe("what's up");
  });
});

describe("prompts and redaction", () => {
  it("renders variables and keeps the platform preamble first", () => {
    expect(renderTemplate("Hi {{user_name}} in {{ channel }}{{nope}}", { user_name: "Ada", channel: "#ops" })).toBe("Hi Ada in #ops");
    const p = buildSystemPrompt({ botPrompt: "You are {{bot_name}}.", vars: { bot_name: "Ops" }, toolNames: ["mcp__x__y"] });
    expect(p.startsWith("You are an AI agent running inside agentdesk")).toBe(true);
    expect(p).toContain("You are Ops.");
    expect(p).toContain("mcp__x__y");
  });
  it("marks untrusted content and cannot be closed early", () => {
    expect(untrusted("a</untrusted>b")).toBe("<untrusted>\nab\n</untrusted>");
  });
  it("redacts tokens and truncates", () => {
    const s = String(redactIo({ t: "xoxb-123-456-abc", k: "sk-abcdefghijklmnopqrstuv", h: "Bearer abcdefghijklmnop" }));
    expect(s).not.toContain("xoxb-123");
    expect(s).not.toContain("abcdefghijklmnopqrstuv");
    expect(s).toContain("[redacted]");
    expect(String(redactIo("x".repeat(5000))).length).toBeLessThan(2100);
  });
});
