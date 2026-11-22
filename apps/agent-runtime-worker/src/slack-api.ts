// The four Slack Web API calls the runtime makes, over fetch (no SDK in the
// bundle). Errors come back as { ok: false, error } like Slack's own.

export interface SlackClient {
  postMessage(args: { channel: string; thread_ts?: string; text: string; username?: string; icon_url?: string }): Promise<{ ok: boolean; ts?: string; error?: string }>;
  update(args: { channel: string; ts: string; text: string }): Promise<{ ok: boolean; error?: string }>;
  replies(args: { channel: string; ts: string; limit?: number }): Promise<{ ok: boolean; messages?: { user?: string; bot_id?: string; text?: string; ts?: string }[]; error?: string }>;
  postEphemeral(args: { channel: string; user: string; text: string; thread_ts?: string }): Promise<{ ok: boolean; error?: string }>;
}

export function slackClient(token: string, apiUrl = "https://slack.com/api/"): SlackClient {
  const base = apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`;
  const call = async (method: string, body: Record<string, unknown>, form = false) => {
    try {
      const res = await fetch(`${base}${method}`, {
        method: "POST",
        headers: form
          ? { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" }
          : { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: form ? new URLSearchParams(Object.entries(body).map(([k, v]): [string, string] => [k, String(v)])).toString() : JSON.stringify(body),
      });
      return (await res.json()) as { ok: boolean; error?: string } & Record<string, unknown>;
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };
  return {
    postMessage: (a) => call("chat.postMessage", { ...a, unfurl_links: false }) as never,
    update: (a) => call("chat.update", a) as never,
    replies: (a) => call("conversations.replies", { channel: a.channel, ts: a.ts, limit: a.limit ?? 50 }, true) as never,
    postEphemeral: (a) => call("chat.postEphemeral", a) as never,
  };
}
