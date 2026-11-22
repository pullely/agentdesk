// A deterministic Workers AI binding (ported from ai-slackbot's
// testing/lib/fake-workers-ai.js): run `<cmd>` → a bash tool call; after a
// tool result → "Tool said: …"; otherwise "Echo: <text>".
const text = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("") : "";

export function fakeAI() {
  const calls: { model: string; tools: string[]; roles: string[] }[] = [];
  return {
    calls,
    async run(model: string, inputs: any) {
      const messages: any[] = Array.isArray(inputs?.messages) ? inputs.messages : [];
      const tools: string[] = (inputs?.tools ?? []).map((t: any) => t?.function?.name ?? t?.name).filter(Boolean);
      calls.push({ model, tools, roles: messages.map((m) => m.role) });
      const last = messages[messages.length - 1] ?? {};
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      let choice;
      if (last.role === "tool") choice = { message: { role: "assistant", content: `Tool said: ${text(last.content).slice(0, 200)}` }, finish_reason: "stop" };
      else {
        const ask = /run `([^`]+)`/.exec(text(lastUser?.content));
        if (ask && tools.includes("bash")) {
          choice = {
            message: { role: "assistant", content: "", tool_calls: [{ id: `call_${messages.length}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: ask[1] }) } }] },
            finish_reason: "tool_calls",
          };
        } else choice = { message: { role: "assistant", content: `Echo: ${text(lastUser?.content)}` }, finish_reason: "stop" };
      }
      return { choices: [choice], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } };
    },
  };
}
