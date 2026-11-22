// A minimal MCP client over Streamable HTTP (MCP spec 2025-06-18): JSON-RPC
// POSTs to one endpoint, answered as application/json or as an SSE stream
// carrying the response. Enough for initialize, tools/list and tools/call.

export const PROTOCOL_VERSION = "2025-06-18";
const CALL_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpConnection {
  url: string;
  bearer?: string | null;
  sessionId?: string | null;
  protocolVersion?: string;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly sessionExpired = false,
  ) {
    super(message);
  }
}

let nextId = 1;

async function readBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new McpError("MCP response too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Pull the JSON-RPC response with `id` out of an SSE body. */
function fromSse(body: string, id: number): unknown {
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const msg = JSON.parse(data) as { id?: unknown };
      if (msg && msg.id === id) return msg;
    } catch {
      // not JSON — skip
    }
  }
  return null;
}

export async function rpc(
  conn: McpConnection,
  method: string,
  params: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<{ result: any; sessionId: string | null }> {
  const id = nextId++;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": conn.protocolVersion ?? PROTOCOL_VERSION,
  };
  if (conn.bearer) headers.authorization = `Bearer ${conn.bearer}`;
  if (conn.sessionId) headers["mcp-session-id"] = conn.sessionId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(conn.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (e) {
    throw new McpError(controller.signal.aborted ? "MCP server timed out" : `MCP server unreachable: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404 && conn.sessionId) throw new McpError("MCP session expired", 404, true);
  if (res.status === 401 || res.status === 403) throw new McpError("MCP server refused the credentials", res.status);
  if (res.status >= 300) throw new McpError(`MCP server answered HTTP ${res.status}`, res.status);
  const sessionId = res.headers.get("mcp-session-id") ?? conn.sessionId ?? null;
  const body = await readBody(res);
  const type = res.headers.get("content-type") ?? "";
  const msg = (type.includes("text/event-stream") ? fromSse(body, id) : JSON.parse(body || "null")) as {
    result?: unknown;
    error?: { message?: string };
  } | null;
  if (!msg) throw new McpError("MCP server sent no response");
  if (msg.error) throw new McpError(`MCP error: ${msg.error.message ?? "unknown"}`);
  return { result: msg.result, sessionId };
}

async function notify(conn: McpConnection, method: string, fetchImpl: typeof fetch): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": conn.protocolVersion ?? PROTOCOL_VERSION,
  };
  if (conn.bearer) headers.authorization = `Bearer ${conn.bearer}`;
  if (conn.sessionId) headers["mcp-session-id"] = conn.sessionId;
  try {
    const res = await fetchImpl(conn.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method }) });
    await res.body?.cancel();
  } catch {
    // notifications are fire-and-forget
  }
}

/** initialize + notifications/initialized; answers the connection to reuse. */
export async function connect(url: string, bearer: string | null, fetchImpl: typeof fetch = fetch): Promise<McpConnection> {
  const conn: McpConnection = { url, bearer };
  const { result, sessionId } = await rpc(
    conn,
    "initialize",
    { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "agentdesk", version: "1.0.0" } },
    fetchImpl,
  );
  const connected: McpConnection = { url, bearer, sessionId, protocolVersion: String(result?.protocolVersion ?? PROTOCOL_VERSION) };
  await notify(connected, "notifications/initialized", fetchImpl);
  return connected;
}

export async function listTools(conn: McpConnection, fetchImpl: typeof fetch = fetch): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const { result } = await rpc(conn, "tools/list", cursor ? { cursor } : {}, fetchImpl);
    for (const t of (result?.tools ?? []) as McpTool[]) if (t?.name) tools.push(t);
    cursor = result?.nextCursor;
    if (!cursor) break;
  }
  return tools.slice(0, 200);
}

export async function callTool(conn: McpConnection, name: string, args: unknown, fetchImpl: typeof fetch = fetch): Promise<{ content: unknown; isError: boolean }> {
  const { result } = await rpc(conn, "tools/call", { name, arguments: args ?? {} }, fetchImpl);
  return { content: result?.content ?? result?.structuredContent ?? null, isError: Boolean(result?.isError) };
}

/** A tool's identity for the re-approval guard: its description and schema. */
export async function descriptionHash(t: McpTool): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([t.description ?? "", t.inputSchema ?? null]));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
