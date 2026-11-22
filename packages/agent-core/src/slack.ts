// Slack request verification, ported unchanged in substance from
// sourceplane/ai-slackbot's slack-utils.ts: HMAC-SHA256 over
// `v0:<timestamp>:<raw body>` with the app's signing secret, WebCrypto,
// constant-time compare, refused when the timestamp is more than five
// minutes from now. `now` is a parameter so tests can pin it.

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string) {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export async function slackSignature(signingSecret: string, timestamp: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${rawBody}`));
  return `v0=${hex(mac)}`;
}

export async function isValidSlackRequest({
  signingSecret,
  timestamp,
  signature,
  rawBody,
  now = Date.now(),
}: {
  signingSecret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  now?: number;
}): Promise<boolean> {
  if (!signingSecret || !timestamp || !signature) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 60 * 5) return false;
  return timingSafeEqual(await slackSignature(signingSecret, timestamp, rawBody), signature);
}

/** Remove the leading mention of the bot from a message. */
export function stripMention(text: string, botUserId?: string): string {
  if (!botUserId) return text.trim();
  return text.replace(new RegExp(`<@${botUserId}>\\s*`, "g"), "").trim();
}
