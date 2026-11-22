import { opaPolicy, wasmPolicyClient, type PolicyClient } from "@ai-sdk/policy-opa";
// The compiled policy, bundled with the Worker as a WebAssembly.Module:
// wrangler turns a `.wasm` import into a module compiled at upload, which is
// the only way a Worker may run WebAssembly. Rebuild it with
// `pnpm --filter @saas/agent-core policy:build` after editing decision.rego.
// (Ported from sourceplane/ai-slackbot apps/api/src/lib/policy/load.ts.)
import policyWasm from "../../policies/policy.wasm";

const POLICY_PATH = "agent/call/decision";

let cached: Promise<unknown> | undefined;

/**
 * The tool-approval function every tool call goes through. One per isolate;
 * a rejected load is not cached, so the next turn retries.
 */
export function loadToolApproval(): Promise<unknown> {
  if (!cached) {
    cached = build();
    cached.catch(() => {
      cached = undefined;
    });
  }
  return cached;
}

/** The policy client itself (tests evaluate decisions through it). */
export async function policyClient(wasm: unknown = policyWasm): Promise<PolicyClient> {
  return wasmPolicyClient({ wasm: wasm as ArrayBuffer });
}

async function build(): Promise<unknown> {
  const client = await policyClient();
  return opaPolicy({ client, path: POLICY_PATH, toInput });
}

// Shell operators (and newlines) that let one call run a second command.
const SHELL_OPERATORS = /[;&|`\n\r]|\|\||&&|\$\(|[<>]/;
const LEADING_ENV_ASSIGNMENT = /^\s*\w+=/;

// Default OPA input shape (mirrors @ai-sdk/policy-opa's DefaultOpaInput). For
// the bash tool we additionally tokenize the command into { program, argv,
// suspicious } so the Rego allowlist can gate it without parsing strings.
// The bot's grants travel in runtimeContext.grants.
export function toInput(args: {
  toolCall: { toolName: string; input: unknown };
  runtimeContext: unknown;
  messages: unknown;
}) {
  const { toolCall, runtimeContext, messages } = args;
  const base = {
    tool: { name: toolCall.toolName },
    args: toolCall.input,
    messages,
    runtimeContext,
  };
  if (toolCall.toolName !== "bash") return base;

  const command = String((toolCall.input as { command?: unknown })?.command ?? "");
  const suspicious = SHELL_OPERATORS.test(command) || LEADING_ENV_ASSIGNMENT.test(command);
  const argv = command.trim().split(/\s+/).filter(Boolean);
  return { ...base, bash: { program: argv[0] ?? "", argv, suspicious } };
}
