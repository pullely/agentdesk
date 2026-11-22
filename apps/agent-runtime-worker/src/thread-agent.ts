import { DurableObject } from "cloudflare:workers";
import type { ModelMessage } from "ai";
import { stripMention, toSlackMrkdwn } from "@saas/agent-core";
import { createVault, kekRingFromEnv } from "@saas/db/agents";
import type { Env } from "./env.js";
import { loadBot, repoFor, runTurn, type ConfigChoice } from "./engine.js";
import { slackClient } from "./slack-api.js";

// THE THREAD AGENT — one Durable Object (SQLite) per
// org:project:team:channel:thread_ts. The gateway hands it a turn with one
// RPC-style fetch; the turn is persisted to this object's FIFO and the call
// returns at once (the gateway then acks Slack). The object's alarm drains
// the FIFO one turn at a time — so two quick messages in a thread answer in
// order — with no 30 s background ceiling. It keeps the thread's memory, the
// config version the thread started on (pinned), and expires after 30 idle
// days.

export interface SlackTurn {
  orgId: string;
  projectId: string;
  env: "stage" | "prod";
  apiAppId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  eventTs: string;
  slackUserId: string;
  text: string;
  botUserId?: string | null;
  botTokenSecretId: string;
}

const IDLE_TTL_MS = 30 * 24 * 3600 * 1000;
const KEEP_MESSAGES = 30;
const COMPACT_AT = 40;
const UPDATE_EVERY_MS = 1200;
const TURNS_PER_ALARM = 10;

export class ThreadAgent extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, ts TEXT)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS turns (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_ts TEXT UNIQUE, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    });
  }

  private meta(key: string): string | null {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0];
    return row ? String(row.value) : null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value);
  }

  /** POST /turn — enqueue and return; the alarm does the work. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/turn") {
      const turn = (await request.json()) as SlackTurn;
      const inserted = this.sql
        .exec(`INSERT INTO turns (event_ts, payload, created_at) VALUES (?, ?, ?) ON CONFLICT (event_ts) DO NOTHING RETURNING seq`, turn.eventTs, JSON.stringify(turn), Date.now())
        .toArray();
      if (inserted.length === 0) return Response.json({ data: { queued: false, duplicate: true } }, { status: 200 });
      this.setMeta("last_active", String(Date.now()));
      await this.ctx.storage.setAlarm(Date.now());
      return Response.json({ data: { queued: true } }, { status: 202 });
    }
    if (request.method === "GET" && url.pathname === "/state") {
      const messages = this.sql.exec(`SELECT COUNT(*) AS n FROM messages`).one().n;
      const pending = this.sql.exec(`SELECT COUNT(*) AS n FROM turns WHERE status = 'pending'`).one().n;
      return Response.json({ data: { messages, pending, pinnedVersion: this.meta("pinned_version") } });
    }
    return new Response("not found", { status: 404 });
  }

  override async alarm(): Promise<void> {
    let processed = 0;
    while (processed < TURNS_PER_ALARM) {
      const next = this.sql.exec(`SELECT seq, payload FROM turns WHERE status = 'pending' ORDER BY seq LIMIT 1`).toArray()[0];
      if (!next) break;
      this.sql.exec(`UPDATE turns SET status = 'running' WHERE seq = ?`, next.seq);
      try {
        await this.process(JSON.parse(String(next.payload)) as SlackTurn);
        this.sql.exec(`UPDATE turns SET status = 'done' WHERE seq = ?`, next.seq);
      } catch (e) {
        console.error("thread-agent: turn failed", (e as Error).message);
        this.sql.exec(`UPDATE turns SET status = 'failed' WHERE seq = ?`, next.seq);
      }
      processed++;
    }
    // Keep only recent turn records; the conversation lives in `messages`.
    this.sql.exec(`DELETE FROM turns WHERE status IN ('done', 'failed') AND seq NOT IN (SELECT seq FROM turns ORDER BY seq DESC LIMIT 50)`);
    const pending = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM turns WHERE status = 'pending'`).one().n);
    if (pending > 0) {
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }
    const lastActive = Number(this.meta("last_active") ?? Date.now());
    if (Date.now() - lastActive >= IDLE_TTL_MS) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.setAlarm(lastActive + IDLE_TTL_MS);
  }

  private async process(turn: SlackTurn): Promise<void> {
    const { repo } = repoFor(this.env);
    const ring = kekRingFromEnv(this.env as unknown as Record<string, unknown>);
    if (!ring) throw new Error("vault not configured");
    const token = await createVault(repo, ring).get(turn.orgId, turn.botTokenSecretId);
    if (!token) throw new Error("installation token missing");
    const slack = slackClient(token, this.env.SLACK_API_URL);

    // The config the thread is pinned to (first turn: stage → draft, prod → published).
    const pinned = this.meta("pinned_version");
    const choice: ConfigChoice = pinned ? { kind: "version", id: pinned } : { kind: turn.env === "stage" ? "draft" : "published" };
    const bot = await loadBot(repo, turn.orgId, turn.projectId, choice);
    if (!bot) {
      await slack.postMessage({ channel: turn.channelId, thread_ts: turn.threadTs, text: "This bot has no published configuration yet." });
      return;
    }
    if (!pinned) this.setMeta("pinned_version", bot.version.id);

    // Thread memory: cold start reads the thread once from Slack.
    const count = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM messages`).one().n);
    if (count === 0 && turn.threadTs !== turn.eventTs) {
      const replies = await slack.replies({ channel: turn.channelId, ts: turn.threadTs, limit: 50 });
      for (const m of replies.messages ?? []) {
        if (!m.text || m.ts === turn.eventTs) continue;
        const role = m.bot_id ? "assistant" : "user";
        this.sql.exec(`INSERT INTO messages (role, content, ts) VALUES (?, ?, ?)`, role, stripMention(m.text, turn.botUserId ?? undefined), m.ts ?? null);
      }
    }
    const userText = stripMention(turn.text, turn.botUserId ?? undefined);
    this.sql.exec(`INSERT INTO messages (role, content, ts) VALUES ('user', ?, ?)`, userText, turn.eventTs);

    const identity = { username: bot.displayName, ...(bot.avatarUrl ? { icon_url: bot.avatarUrl } : {}) };
    const placeholder = await slack.postMessage({ channel: turn.channelId, thread_ts: turn.threadTs, text: "_is thinking…_", ...identity });
    let lastUpdate = 0;
    let lastText = "";
    const onText = async (text: string) => {
      if (!placeholder.ts || Date.now() - lastUpdate < UPDATE_EVERY_MS || text === lastText) return;
      lastUpdate = Date.now();
      lastText = text;
      await slack.update({ channel: turn.channelId, ts: placeholder.ts, text: `${toSlackMrkdwn(text)} …` });
    };

    const result = await runTurn(this.env, bot, {
      orgId: turn.orgId,
      projectId: turn.projectId,
      env: turn.env,
      source: "slack",
      messages: this.history(),
      channelId: turn.channelId,
      teamId: turn.teamId,
      threadTs: turn.threadTs,
      slackUserId: turn.slackUserId,
      userName: `<@${turn.slackUserId}>`,
      onText,
    });

    if (placeholder.ts) await slack.update({ channel: turn.channelId, ts: placeholder.ts, text: result.reply });
    else await slack.postMessage({ channel: turn.channelId, thread_ts: turn.threadTs, text: result.reply, ...identity });
    if (result.status === "completed") {
      this.sql.exec(`INSERT INTO messages (role, content, ts) VALUES ('assistant', ?, ?)`, result.reply, placeholder.ts ?? null);
    }
    this.compact();
  }

  /** The model's view of the thread: the compacted summary, then recent messages. */
  private history(): ModelMessage[] {
    const rows = this.sql.exec(`SELECT role, content FROM messages ORDER BY seq DESC LIMIT ?`, KEEP_MESSAGES).toArray().reverse();
    const summary = this.meta("summary");
    const messages: ModelMessage[] = rows.map((r) => ({ role: r.role === "assistant" ? "assistant" : "user", content: String(r.content) }) as ModelMessage);
    if (summary) messages.unshift({ role: "user", content: `(Earlier in this thread, summarized)\n${summary}` });
    // The model expects the conversation to open with the user.
    while (messages.length && messages[0]!.role === "assistant") messages.shift();
    return messages;
  }

  /** Past COMPACT_AT messages, fold the oldest into a bounded digest. */
  private compact(): void {
    const total = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM messages`).one().n);
    if (total <= COMPACT_AT) return;
    const old = this.sql.exec(`SELECT seq, role, content FROM messages ORDER BY seq LIMIT ?`, total - KEEP_MESSAGES).toArray();
    const digest = old.map((r) => `- ${r.role}: ${String(r.content).replace(/\s+/g, " ").slice(0, 200)}`).join("\n");
    const summary = `${this.meta("summary") ?? ""}\n${digest}`.trim().slice(-6000);
    this.setMeta("summary", summary);
    const lastSeq = old[old.length - 1]?.seq;
    if (lastSeq !== undefined) this.sql.exec(`DELETE FROM messages WHERE seq <= ?`, lastSeq);
  }
}

/** The object's name: tenant-prefixed, one per Slack thread. */
export function threadName(t: Pick<SlackTurn, "orgId" | "projectId" | "teamId" | "channelId" | "threadTs">): string {
  return `${t.orgId}:${t.projectId}:${t.teamId}:${t.channelId}:${t.threadTs}`;
}
