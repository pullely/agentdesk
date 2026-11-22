"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import type { AgentRun, BotConfigVersion, GrantMode, SlackBinding, ToolGrant } from "@saas/contracts/agents";
import { OrgScope } from "@/components/shell/org-scope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";

// agentdesk — the bot builder. A project is one bot: its Agent (profile,
// prompt, model), Tools (grants), Channels (Slack bindings), Playground (the
// draft config, with its trace), Runs, and Publish.

const BUILTINS = ["getWeather", "throwDice", "searchWeb", "bash", "readFile", "writeFile"];
const WORKERS_AI = ["@cf/moonshotai/kimi-k2.6", "@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/qwen/qwen3-30b-a3b-fp8", "@cf/openai/gpt-oss-120b"];

export default function BotPage() {
  const params = useParams<{ orgSlug: string; projectSlug: string }>();
  const orgSlug = params?.orgSlug ?? "";
  const projectSlug = params?.projectSlug ?? "";
  return <OrgScope slug={orgSlug}>{(org) => <Resolve orgId={org.id} projectSlug={projectSlug} />}</OrgScope>;
}

function Resolve({ orgId, projectSlug }: { orgId: string; projectSlug: string }) {
  const { client } = useSession();
  const projects = useApiQuery(qk.projects(orgId), () => wrap(async () => (await client.projects.list(orgId)).projects));
  const project = projects.data?.find((p) => p.slug === projectSlug) ?? null;
  if (!project) return <p className="text-sm text-muted-foreground">{projects.loading ? "Loading…" : "Project not found."}</p>;
  return <Builder orgId={orgId} projectId={project.id} projectName={project.name} />;
}

function Builder({ orgId, projectId, projectName }: { orgId: string; projectId: string; projectName: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const bot = useApiQuery(["agents", "bot", orgId, projectId], () => wrap(() => client.agents.getBot(orgId, projectId)));
  const keys = useApiQuery(["agents", "keys", orgId], () => wrap(() => client.agents.listModelKeys(orgId)));
  const draft = bot.data?.draft ?? bot.data?.published ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{bot.data?.profile?.displayName ?? projectName}</h1>
          <p className="text-sm text-muted-foreground">
            {bot.data?.published ? <>Published v{bot.data.published.version}</> : "Not published"}
            {bot.data?.draft ? <> · draft v{bot.data.draft.version}</> : null}
          </p>
        </div>
        <PublishButton orgId={orgId} projectId={projectId} canPublish={Boolean(bot.data?.draft)} onDone={() => bot.reload()} />
      </div>
      <Tabs defaultValue="agent">
        <TabsList>
          <TabsTrigger value="agent">Agent</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="channels">Channels</TabsTrigger>
          <TabsTrigger value="playground">Playground</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>
        <TabsContent value="agent">
          <AgentTab
            key={draft?.id ?? "new"}
            orgId={orgId}
            projectId={projectId}
            draft={draft}
            displayName={bot.data?.profile?.displayName ?? projectName}
            avatarUrl={bot.data?.profile?.avatarUrl ?? ""}
            keys={(keys.data ?? []).filter((k) => k.provider !== "exa" && k.status === "valid")}
            onSaved={() => {
              bot.reload();
              toast({ kind: "success", title: "Draft saved" });
            }}
          />
        </TabsContent>
        <TabsContent value="tools">
          <ToolsTab orgId={orgId} projectId={projectId} />
        </TabsContent>
        <TabsContent value="channels">
          <ChannelsTab orgId={orgId} projectId={projectId} />
        </TabsContent>
        <TabsContent value="playground">
          <PlaygroundTab orgId={orgId} projectId={projectId} />
        </TabsContent>
        <TabsContent value="runs">
          <RunsTab orgId={orgId} projectId={projectId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PublishButton({ orgId, projectId, canPublish, onDone }: { orgId: string; projectId: string; canPublish: boolean; onDone: () => void }) {
  const { client } = useSession();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  const publish = async () => {
    setBusy(true);
    const r = await wrap(() => client.agents.publish(orgId, projectId));
    setBusy(false);
    if (!r.ok) return toast({ kind: "error", title: "Not published", description: r.error.message });
    toast({ kind: "success", title: `Published v${r.data.version}` });
    onDone();
  };
  return (
    <Button onClick={publish} disabled={!canPublish || busy}>
      {busy ? "Publishing…" : "Publish draft"}
    </Button>
  );
}

function AgentTab(props: {
  orgId: string;
  projectId: string;
  draft: BotConfigVersion | null;
  displayName: string;
  avatarUrl: string;
  keys: { id: string; label: string; provider: string; last4: string }[];
  onSaved: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [name, setName] = React.useState(props.displayName);
  const [avatar, setAvatar] = React.useState(props.avatarUrl);
  const [prompt, setPrompt] = React.useState(props.draft?.systemPrompt ?? "");
  const [modelRef, setModelRef] = React.useState(props.draft?.modelRef ?? `workers-ai:${WORKERS_AI[0]}`);
  const [keyId, setKeyId] = React.useState(props.draft?.providerKeyId ?? "");
  const [temperature, setTemperature] = React.useState(String(props.draft?.params.temperature ?? 0.3));
  const [maxSteps, setMaxSteps] = React.useState(String(props.draft?.params.maxSteps ?? 8));
  const [saving, setSaving] = React.useState(false);
  const byok = !modelRef.startsWith("workers-ai:");

  const save = async () => {
    setSaving(true);
    const profile = await wrap(() => client.agents.updateProfile(props.orgId, props.projectId, { displayName: name, ...(avatar ? { avatarUrl: avatar } : {}) }));
    const r = await wrap(() =>
      client.agents.updateDraft(props.orgId, props.projectId, {
        systemPrompt: prompt,
        modelRef,
        providerKeyId: byok ? keyId || null : null,
        params: { temperature: Number(temperature), maxSteps: Number(maxSteps) },
      }),
    );
    setSaving(false);
    if (!profile.ok) return toast({ kind: "error", title: "Profile not saved", description: profile.error.message });
    if (!r.ok) return toast({ kind: "error", title: "Draft not saved", description: r.error.message });
    props.onSaved();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent</CardTitle>
        <CardDescription>
          The system prompt may use {"{{bot_name}}"}, {"{{user_name}}"}, {"{{channel}}"} and {"{{date}}"}. agentdesk always prepends its safety preamble.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>Name in Slack</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Avatar URL (https)</Label>
            <Input value={avatar} onChange={(e) => setAvatar(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1">
          <Label>System prompt</Label>
          <textarea className="min-h-[160px] w-full rounded-md border bg-background p-2 font-mono text-sm" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="You are {{bot_name}}, the on-call assistant for the platform team…" />
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1 sm:col-span-2">
            <Label>Model</Label>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={modelRef} onChange={(e) => setModelRef(e.target.value)}>
              {WORKERS_AI.map((m) => (
                <option key={m} value={`workers-ai:${m}`}>Workers AI · {m.replace("@cf/", "")}</option>
              ))}
              {props.keys.some((k) => k.provider === "openai") ? (
                <>
                  <option value="openai:gpt-4o">OpenAI · gpt-4o</option>
                  <option value="openai:gpt-4o-mini">OpenAI · gpt-4o-mini</option>
                </>
              ) : null}
              {props.keys.some((k) => k.provider === "anthropic") ? (
                <>
                  <option value="anthropic:claude-sonnet-5-5">Anthropic · claude-sonnet-5-5</option>
                  <option value="anthropic:claude-haiku-5-5">Anthropic · claude-haiku-5-5</option>
                </>
              ) : null}
            </select>
          </div>
          <div className="space-y-1">
            <Label>Temperature</Label>
            <Input value={temperature} onChange={(e) => setTemperature(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Max steps</Label>
            <Input value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} />
          </div>
        </div>
        {byok ? (
          <div className="space-y-1">
            <Label>Model key</Label>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={keyId} onChange={(e) => setKeyId(e.target.value)}>
              <option value="">Choose a key…</option>
              {props.keys
                .filter((k) => modelRef.startsWith(`${k.provider}:`))
                .map((k) => (
                  <option key={k.id} value={k.id}>{k.label} · …{k.last4}</option>
                ))}
            </select>
          </div>
        ) : null}
        <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save draft"}</Button>
      </CardContent>
    </Card>
  );
}

function ToolsTab({ orgId, projectId }: { orgId: string; projectId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const grants = useApiQuery(["agents", "grants", orgId, projectId], () => wrap(() => client.agents.listGrants(orgId, projectId)));
  const servers = useApiQuery(["agents", "connectors", orgId], () => wrap(() => client.agents.listConnectors(orgId)));
  const [local, setLocal] = React.useState<Record<string, GrantMode | "off">>({});
  React.useEffect(() => {
    if (!grants.data) return;
    const m: Record<string, GrantMode | "off"> = {};
    for (const g of grants.data) m[`${g.serverId}/${g.toolName}`] = g.mode;
    setLocal(m);
  }, [grants.data]);

  const rows: { serverId: string; serverName: string; tool: string; description: string }[] = [
    ...BUILTINS.map((t) => ({ serverId: "builtin", serverName: "built-in", tool: t, description: "" })),
    ...(servers.data ?? []).flatMap((s) => s.tools.map((t) => ({ serverId: s.id, serverName: s.name, tool: t.name, description: t.description }))),
  ];

  const save = async () => {
    const list: ToolGrant[] = Object.entries(local)
      .filter(([, mode]) => mode !== "off")
      .map(([k, mode]) => {
        const i = k.indexOf("/");
        return { serverId: k.slice(0, i), toolName: k.slice(i + 1), mode: mode as GrantMode };
      });
    const r = await wrap(() => client.agents.replaceGrants(orgId, projectId, list));
    if (!r.ok) return toast({ kind: "error", title: "Grants not saved", description: r.error.message });
    toast({ kind: "success", title: `${r.data.length} tools granted — publish to apply them in Slack` });
    grants.reload();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tools</CardTitle>
        <CardDescription>Only granted tools reach the model. Every call is checked by the policy; &ldquo;ask first&rdquo; posts Approve/Deny in Slack once approvals ship (AD2) — until then it is refused.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="divide-y rounded-md border">
          {rows.map((r) => {
            const k = `${r.serverId}/${r.tool}`;
            return (
              <li key={k} className="flex items-center justify-between gap-2 p-2 text-sm">
                <span className="min-w-0">
                  <span className="font-mono">{r.tool}</span> <Badge variant="outline">{r.serverName}</Badge>
                  {r.description ? <span className="block truncate text-xs text-muted-foreground">{r.description}</span> : null}
                </span>
                <select className="h-8 rounded-md border bg-background px-2 text-sm" value={local[k] ?? "off"} onChange={(e) => setLocal({ ...local, [k]: e.target.value as GrantMode | "off" })}>
                  <option value="off">not granted</option>
                  <option value="allow">allow</option>
                  <option value="approve">ask first</option>
                  <option value="deny">deny</option>
                </select>
              </li>
            );
          })}
        </ul>
        <Button onClick={save}>Save grants</Button>
      </CardContent>
    </Card>
  );
}

function ChannelsTab({ orgId, projectId }: { orgId: string; projectId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const installs = useApiQuery(["agents", "slack", orgId], () => wrap(() => client.agents.listSlackInstallations(orgId)));
  const bindings = useApiQuery(["agents", "bindings", orgId, projectId], () => wrap(() => client.agents.listBindings(orgId, projectId)));
  const [rows, setRows] = React.useState<SlackBinding[]>([]);
  React.useEffect(() => {
    if (bindings.data) setRows(bindings.data);
  }, [bindings.data]);
  const team = installs.data?.find((i) => i.status === "active")?.teamId ?? "";
  const add = () => setRows([...rows, { teamId: team, channelId: "", env: "prod", trigger: "mention", commandSlug: null }]);
  const save = async () => {
    const r = await wrap(() => client.agents.replaceBindings(orgId, projectId, rows));
    if (!r.ok) return toast({ kind: "error", title: "Channels not saved", description: r.error.message });
    toast({ kind: "success", title: "Channels saved" });
    bindings.reload();
  };
  if (!team) return <p className="text-sm text-muted-foreground">Connect a Slack workspace on the Agents page first.</p>;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Channels</CardTitle>
        <CardDescription>Where this bot answers. Stage bindings run the draft — use them in a test channel.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((b, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-5">
            <select className="h-9 rounded-md border bg-background px-2 text-sm" value={b.trigger} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, trigger: e.target.value as SlackBinding["trigger"] } : x)))}>
              <option value="mention">@mention in channel</option>
              <option value="all">every message in channel</option>
              <option value="dm">direct messages</option>
              <option value="command">/agent command</option>
            </select>
            <Input placeholder={b.trigger === "command" ? "command slug" : "channel id (C…)"} value={b.trigger === "command" ? b.commandSlug ?? "" : b.channelId} disabled={b.trigger === "dm"} onChange={(e) => setRows(rows.map((x, j) => (j === i ? (b.trigger === "command" ? { ...x, commandSlug: e.target.value } : { ...x, channelId: e.target.value }) : x)))} />
            <select className="h-9 rounded-md border bg-background px-2 text-sm" value={b.env} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, env: e.target.value as "stage" | "prod" } : x)))}>
              <option value="prod">published (prod)</option>
              <option value="stage">draft (stage)</option>
            </select>
            <Button variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <div className="flex gap-2">
          <Button variant="outline" onClick={add}>Add channel</Button>
          <Button onClick={save}>Save channels</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PlaygroundTab({ orgId, projectId }: { orgId: string; projectId: string }) {
  const { client } = useSession();
  const [messages, setMessages] = React.useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [trace, setTrace] = React.useState<AgentRun | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const send = async () => {
    if (!input.trim()) return;
    const next = [...messages, { role: "user" as const, content: input.trim() }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setError(null);
    const r = await wrap(() => client.agents.playground(orgId, projectId, { messages: next }));
    setBusy(false);
    if (!r.ok) return setError(r.error.message);
    setMessages([...next, { role: "assistant", content: r.data.reply }]);
    setTrace(r.data.run);
  };
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Playground</CardTitle>
          <CardDescription>Chat with the draft config — same runtime, same policy, no Slack.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="min-h-[240px] space-y-2 rounded-md border p-3 text-sm">
            {messages.length === 0 ? <p className="text-muted-foreground">Say hello to your bot.</p> : null}
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "text-right" : ""}>
                <span className={`inline-block whitespace-pre-wrap rounded-md px-3 py-2 ${m.role === "user" ? "bg-primary/10" : "bg-muted"}`}>{m.content}</span>
              </div>
            ))}
            {busy ? <p className="text-muted-foreground">thinking…</p> : null}
            {error ? <p className="text-destructive">{error}</p> : null}
          </div>
          <div className="flex gap-2">
            <Input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? void send() : undefined)} placeholder="Ask something…" />
            <Button onClick={send} disabled={busy}>Send</Button>
            <Button variant="ghost" onClick={() => { setMessages([]); setTrace(null); }}>Reset</Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Trace</CardTitle>
          <CardDescription>{trace ? `${trace.model ?? ""} · ${trace.tokensIn}/${trace.tokensOut} tokens · ${trace.latencyMs ?? 0} ms` : "The last run's steps."}</CardDescription>
        </CardHeader>
        <CardContent>
          <Steps run={trace} />
        </CardContent>
      </Card>
    </div>
  );
}

function Steps({ run }: { run: AgentRun | null }) {
  if (!run) return <p className="text-sm text-muted-foreground">No run yet.</p>;
  return (
    <ol className="space-y-2 text-xs">
      {run.error ? <li className="text-destructive">{run.error}</li> : null}
      {(run.steps ?? []).map((s) => (
        <li key={s.seq} className="rounded border p-2">
          <span className="font-medium">{s.kind}</span>
          {s.tool ? <span className="font-mono"> {s.tool}</span> : null}
          {s.policyDecision ? <Badge className="ml-1" variant={s.policyDecision === "allow" ? "success" : "destructive"}>{s.policyDecision}</Badge> : null}
          {s.durationMs !== null ? <span className="text-muted-foreground"> · {s.durationMs} ms</span> : null}
          {s.io ? <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-muted-foreground">{typeof s.io === "string" ? s.io : JSON.stringify(s.io)}</pre> : null}
        </li>
      ))}
    </ol>
  );
}

function RunsTab({ orgId, projectId }: { orgId: string; projectId: string }) {
  const { client } = useSession();
  const runs = useApiQuery(["agents", "runs", orgId, projectId], () => wrap(() => client.agents.listRuns(orgId, projectId, { limit: 50 })));
  const [open, setOpen] = React.useState<AgentRun | null>(null);
  const view = async (r: AgentRun) => {
    const full = await wrap(() => client.agents.getRun(orgId, r.id));
    if (full.ok) setOpen(full.data);
  };
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Runs</CardTitle>
          <CardDescription>Every turn the bot answered, in Slack and the playground.</CardDescription>
        </CardHeader>
        <CardContent>
          {runs.data && runs.data.length > 0 ? (
            <ul className="divide-y rounded-md border text-sm">
              {runs.data.map((r) => (
                <li key={r.id}>
                  <button className="flex w-full items-center justify-between gap-2 p-2 text-left hover:bg-accent" onClick={() => view(r)}>
                    <span>
                      <Badge variant={r.status === "completed" ? "success" : r.status === "failed" ? "destructive" : "secondary"}>{r.status}</Badge>{" "}
                      <span className="text-muted-foreground">{r.source} · {r.env}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {r.tokensIn}/{r.tokensOut} tok · {r.latencyMs ?? "–"} ms · {new Date(r.startedAt).toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{runs.loading ? "Loading…" : runs.error ? runs.error.message : "No runs yet."}</p>
          )}
          <Button className="mt-3" variant="outline" onClick={() => runs.reload()}>Refresh</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Step trace</CardTitle>
          <CardDescription>{open ? `${open.model ?? ""} · ${open.error ?? open.status}` : "Pick a run."}</CardDescription>
        </CardHeader>
        <CardContent>
          <Steps run={open} />
        </CardContent>
      </Card>
    </div>
  );
}
