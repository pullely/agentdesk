import { stepCountIs, streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { loadToolApproval } from "./policy/load";

// THE AGENT LOOP. Ported from sourceplane/ai-slackbot's run-agent.ts (itself
// from vercel-labs/ai-sdk-slackbot): the AI SDK loop with a step cap, every
// tool call gated by the OPA policy, and every tool outcome classified for
// the reply footer. What changed for agentdesk: the prompt, the model, the
// step cap and the tools come from the bot's config; the loop streams (the
// caller edits its Slack message as text arrives); and each step is reported
// so the run can be recorded.

export type GrantMode = "allow" | "approve" | "deny";

export interface Grant {
  mode: GrantMode;
  argConstraints?: Record<string, string>;
}

/** Grants keyed by the tool name the model sees. */
export type Grants = Record<string, Grant>;

export interface AgentRuntimeContext {
  orgId: string;
  projectId: string;
  channelId?: string;
  userId?: string;
  grants: Grants;
  [key: string]: unknown;
}

export type ToolStatus = "used" | "denied" | "failed";

export interface ToolOutcome {
  toolName: string;
  status: ToolStatus;
  reason?: string;
}

export interface RunStep {
  kind: "llm" | "tool" | "approval";
  tool?: string;
  policyDecision?: "allow" | "deny" | "approve";
  durationMs: number;
  /** Truncated, secret-free input/output for the trace view. */
  io?: unknown;
}

export interface AgentResult {
  text: string;
  outcomes: ToolOutcome[];
  steps: RunStep[];
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * What to do with a call the policy says needs a human. AD1 has no approval
 * flow, so the default refuses it with a reason the model relays.
 */
export type ApprovalHandler = (call: { toolName: string; input: unknown; reason?: string }) => Promise<
  { approved: true } | { approved: false; reason: string }
>;

const refuseApproval: ApprovalHandler = async ({ toolName }) => ({
  approved: false,
  reason: `${toolName} needs an approval, and approvals in Slack are not enabled for this bot yet.`,
});

export interface RunAgentInput {
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  runtimeContext: AgentRuntimeContext;
  maxSteps?: number;
  temperature?: number;
  maxOutputTokens?: number;
  /** Called with the whole text so far, as it grows. */
  onText?: (textSoFar: string) => void | Promise<void>;
  onApproval?: ApprovalHandler;
  /** Injected in tests; the bundled WASM policy otherwise. */
  toolApproval?: unknown;
  abortSignal?: AbortSignal;
}

const MAX_IO_CHARS = 2000;

export function redactIo(value: unknown): unknown {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s === undefined) return undefined;
  // Strip anything shaped like a credential before it reaches storage.
  s = s
    .replace(/xox[abprs]-[A-Za-z0-9-]+/g, "xox?-[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]");
  return s.length > MAX_IO_CHARS ? `${s.slice(0, MAX_IO_CHARS)}…[truncated]` : s;
}

export async function runAgent(input: RunAgentInput): Promise<AgentResult> {
  const opa = (input.toolApproval ?? (await loadToolApproval())) as (opts: unknown) => Promise<unknown>;
  const onApproval = input.onApproval ?? refuseApproval;
  const steps: RunStep[] = [];
  const decisions = new Map<string, "allow" | "deny" | "approve">();

  // The policy decides; a "user-approval" answer goes to the approval
  // handler (AD1: refused). The decision is remembered per tool call id so
  // the trace can show it.
  const toolApproval = async (opts: { toolCall: { toolCallId: string; toolName: string; input: unknown } }) => {
    const status = (await opa(opts)) as { type?: string; reason?: string } | string | undefined;
    const type = typeof status === "string" ? status : status?.type;
    const reason = typeof status === "object" ? status?.reason : undefined;
    if (type === "user-approval") {
      decisions.set(opts.toolCall.toolCallId, "approve");
      const started = Date.now();
      const answer = await onApproval({ toolName: opts.toolCall.toolName, input: opts.toolCall.input, ...(reason ? { reason } : {}) });
      steps.push({
        kind: "approval",
        tool: opts.toolCall.toolName,
        policyDecision: "approve",
        durationMs: Date.now() - started,
        io: redactIo({ approved: answer.approved, reason: answer.approved ? undefined : answer.reason }),
      });
      return answer.approved ? { type: "approved" as const } : { type: "denied" as const, reason: answer.reason };
    }
    decisions.set(opts.toolCall.toolCallId, type === "denied" ? "deny" : "allow");
    return (typeof status === "string" ? { type: status } : status) as never;
  };

  let stepStarted = Date.now();
  const result = streamText({
    model: input.model,
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    stopWhen: stepCountIs(input.maxSteps ?? 10),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    runtimeContext: input.runtimeContext as never,
    toolApproval: toolApproval as never,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    onStepFinish: () => {
      const now = Date.now();
      steps.push({ kind: "llm", durationMs: now - stepStarted });
      stepStarted = now;
    },
  });

  let text = "";
  for await (const delta of result.textStream) {
    text += delta;
    if (input.onText) await input.onText(text);
  }

  const outcomes: ToolOutcome[] = [];
  const allSteps = (await result.steps) ?? [];
  for (const step of allSteps as unknown as { content?: unknown[] }[]) {
    for (const part of (step.content ?? []) as Record<string, any>[]) {
      if (part?.type === "tool-result" || part?.type === "tool-error") {
        const outputType = part.output?.type;
        const failed = part.type === "tool-error" || outputType === "error-text" || outputType === "error-json";
        const reason = failed
          ? String(part.error ?? part.output?.value ?? "unknown error")
          : undefined;
        outcomes.push({ toolName: part.toolName, status: failed ? "failed" : "used", ...(reason ? { reason } : {}) });
        steps.push({
          kind: "tool",
          tool: part.toolName,
          policyDecision: decisions.get(part.toolCallId) ?? "allow",
          durationMs: 0,
          io: redactIo({ input: part.input, output: failed ? reason : part.output }),
        });
      } else if (part?.type === "tool-approval-response" && part.approved === false) {
        const toolName = part.toolCall?.toolName ?? "tool";
        outcomes.push({ toolName, status: "denied", reason: part.reason });
        steps.push({
          kind: "tool",
          tool: toolName,
          policyDecision: "deny",
          durationMs: 0,
          io: redactIo({ input: part.toolCall?.input, denied: part.reason }),
        });
      }
    }
  }

  const usage = (await result.totalUsage) as { inputTokens?: number; outputTokens?: number } | undefined;
  return {
    text: text || ((await result.text) ?? ""),
    outcomes,
    steps,
    usage: { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 },
  };
}

// The reply footer, upstream's: every tool and its outcome, "🔧 none" when no
// tool ran, so a tool-less (possibly hallucinated) answer is never ambiguous.
export function formatReply(text: string, outcomes: ToolOutcome[]): string {
  const footer =
    outcomes.length > 0 ? `\n\n_🔧 ${[...new Set(outcomes.map(toolLabel))].join(", ")}_` : "\n\n_🔧 none_";
  const answer = toSlackMrkdwn(text);
  const problems = outcomes.filter((o) => o.status !== "used").map((o) => o.reason ?? `${o.toolName} ${o.status}`);
  const anySuccess = outcomes.some((o) => o.status === "used");
  if (problems.length > 0 && !anySuccess) return problems.join("\n") + footer;
  if (problems.length > 0) return [answer, ...problems].join("\n\n") + footer;
  return answer + footer;
}

export function toSlackMrkdwn(text: string): string {
  return text.replace(/\[(.*?)\]\((.*?)\)/g, "<$2|$1>").replace(/\*\*/g, "*");
}

function toolLabel(outcome: ToolOutcome): string {
  if (outcome.status === "used") return outcome.toolName;
  return `${outcome.toolName} (${outcome.status === "denied" ? "blocked by policy" : "failed"})`;
}
