import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { opaPolicy } from "@ai-sdk/policy-opa";
import { policyClient, toInput } from "@saas/agent-core";

const here = dirname(fileURLToPath(import.meta.url));
export const POLICY_WASM = join(here, "../../../packages/agent-core/policies/policy.wasm");

/** The real compiled policy, evaluated under Node. */
export async function realPolicy() {
  const bytes = readFileSync(POLICY_WASM);
  const client = await policyClient(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return { client, approval: opaPolicy({ client, path: "agent/call/decision", toInput }) };
}
