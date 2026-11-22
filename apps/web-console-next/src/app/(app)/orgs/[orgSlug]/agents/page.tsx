"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import type { McpServer, ModelKey, ModelKeyProvider, SlackInstallation } from "@saas/contracts/agents";
import { OrgScope } from "@/components/shell/org-scope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery } from "@/lib/query";

// agentdesk — the org's Agents area: Slack connections, model keys (BYOK),
// MCP connectors. Each bot (a project) is configured on its Bot page.

export default function AgentsPage() {
  const params = useParams<{ orgSlug: string }>();
  const orgSlug = params?.orgSlug ?? "";
  return <OrgScope slug={orgSlug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

const PROVIDERS: { value: ModelKeyProvider; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openai-compatible", label: "OpenAI-compatible" },
  { value: "exa", label: "Exa (web search tool)" },
];

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const slack = useApiQuery(["agents", "slack", orgId], () => wrap(() => client.agents.listSlackInstallations(orgId)));
  const keys = useApiQuery(["agents", "keys", orgId], () => wrap(() => client.agents.listModelKeys(orgId)));
  const connectors = useApiQuery(["agents", "connectors", orgId], () => wrap(() => client.agents.listConnectors(orgId)));

  // ── Slack ──
  const addToSlack = async () => {
    const r = await wrap(() => client.agents.slackInstallUrl(orgId, window.location.href));
    if (!r.ok) return toast({ kind: "error", title: "Slack is not available yet", description: r.error.message });
    window.location.href = r.data.url;
  };
  const [app, setApp] = React.useState({ apiAppId: "", teamId: "", botToken: "", signingSecret: "" });
  const registerApp = async () => {
    const r = await wrap(() =>
      client.agents.registerSlackApp(orgId, {
        apiAppId: app.apiAppId.trim(),
        teamId: app.teamId.trim(),
        botToken: app.botToken.trim(),
        ...(app.signingSecret.trim() ? { signingSecret: app.signingSecret.trim() } : {}),
      }),
    );
    if (!r.ok) return toast({ kind: "error", title: "Could not register the app", description: r.error.message });
    setApp({ apiAppId: "", teamId: "", botToken: "", signingSecret: "" });
    toast({ kind: "success", title: `Connected ${r.data.teamName ?? r.data.teamId}` });
    slack.reload();
  };
  const removeInstall = async (i: SlackInstallation) => {
    const r = await wrap(() => client.agents.removeSlackInstallation(orgId, `${i.teamId}`));
    if (!r.ok) return toast({ kind: "error", title: "Could not disconnect", description: r.error.message });
    slack.reload();
  };

  // ── Model keys ──
  const [key, setKey] = React.useState<{ provider: ModelKeyProvider; label: string; key: string; baseUrl: string }>({ provider: "openai", label: "", key: "", baseUrl: "" });
  const [savingKey, setSavingKey] = React.useState(false);
  const addKey = async () => {
    setSavingKey(true);
    const r = await wrap(() =>
      client.agents.addModelKey(orgId, {
        provider: key.provider,
        key: key.key.trim(),
        ...(key.label.trim() ? { label: key.label.trim() } : {}),
        ...(key.provider === "openai-compatible" ? { baseUrl: key.baseUrl.trim() } : {}),
      }),
    );
    setSavingKey(false);
    if (!r.ok) return toast({ kind: "error", title: "Key not saved", description: r.error.message });
    setKey({ provider: key.provider, label: "", key: "", baseUrl: "" });
    toast({ kind: "success", title: `Saved ${r.data.label} (…${r.data.last4})` });
    keys.reload();
  };
  const removeKey = async (k: ModelKey) => {
    const r = await wrap(() => client.agents.removeModelKey(orgId, k.id));
    if (!r.ok) return toast({ kind: "error", title: "Could not remove", description: r.error.message });
    keys.reload();
  };

  // ── Connectors ──
  const [mcp, setMcp] = React.useState({ name: "", url: "", token: "" });
  const [savingMcp, setSavingMcp] = React.useState(false);
  const addConnector = async () => {
    setSavingMcp(true);
    const r = await wrap(() =>
      client.agents.addConnector(orgId, {
        name: mcp.name.trim(),
        url: mcp.url.trim(),
        authType: mcp.token.trim() ? "bearer" : "none",
        ...(mcp.token.trim() ? { token: mcp.token.trim() } : {}),
      }),
    );
    setSavingMcp(false);
    if (!r.ok) return toast({ kind: "error", title: "Connector not added", description: r.error.message });
    setMcp({ name: "", url: "", token: "" });
    toast({ kind: "success", title: `Added ${r.data.name} — ${r.data.tools.length} tools` });
    connectors.reload();
  };
  const sync = async (s: McpServer) => {
    const r = await wrap(() => client.agents.syncConnector(orgId, s.id));
    if (!r.ok) return toast({ kind: "error", title: "Sync failed", description: r.error.message });
    toast({
      kind: r.data.changedTools.length ? "error" : "success",
      title: r.data.changedTools.length ? `Changed descriptions: ${r.data.changedTools.join(", ")} — re-grant them` : `${r.data.tools.length} tools, no changes`,
    });
    connectors.reload();
  };
  const removeConnector = async (s: McpServer) => {
    const r = await wrap(() => client.agents.removeConnector(orgId, s.id));
    if (!r.ok) return toast({ kind: "error", title: "Could not remove", description: r.error.message });
    connectors.reload();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
        <p className="text-sm text-muted-foreground">
          Connect Slack, bring your own model keys and MCP servers. Each project is one bot — configure it on the project&apos;s Bot page.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Slack</CardTitle>
          <CardDescription>Workspaces your bots answer in. One workspace can hold several bots.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button onClick={addToSlack}>Add to Slack</Button>
          </div>
          {slack.data && slack.data.length > 0 ? (
            <ul className="divide-y rounded-md border">
              {slack.data.map((i) => (
                <li key={`${i.teamId}`} className="flex items-center justify-between gap-2 p-3 text-sm">
                  <span>
                    <span className="font-medium">{i.teamName ?? i.teamId}</span>{" "}
                    <Badge variant="secondary">{i.mode === "byo" ? "own app" : "shared app"}</Badge>{" "}
                    <Badge variant={i.status === "active" ? "success" : "destructive"}>{i.status}</Badge>
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => removeInstall(i)}>Disconnect</Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{slack.loading ? "Loading…" : slack.error ? slack.error.message : "No Slack workspace connected yet."}</p>
          )}
          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-sm font-medium">Register a Slack app you created</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="App ID (A…)" value={app.apiAppId} onChange={(v) => setApp({ ...app, apiAppId: v })} />
              <Field label="Team ID (T…)" value={app.teamId} onChange={(v) => setApp({ ...app, teamId: v })} />
              <Field label="Bot token (xoxb-…)" type="password" value={app.botToken} onChange={(v) => setApp({ ...app, botToken: v })} />
              <Field label="Signing secret (your own app)" type="password" value={app.signingSecret} onChange={(v) => setApp({ ...app, signingSecret: v })} />
            </div>
            <Button className="mt-3" variant="outline" onClick={registerApp} disabled={!app.apiAppId || !app.teamId || !app.botToken}>
              Register
            </Button>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Model keys</CardTitle>
          <CardDescription>Workers AI is included. Bring your own OpenAI, Anthropic or compatible key — verified on save, stored encrypted, shown only by its last four characters.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {keys.data && keys.data.length > 0 ? (
            <ul className="divide-y rounded-md border">
              {keys.data.map((k) => (
                <li key={k.id} className="flex items-center justify-between gap-2 p-3 text-sm">
                  <span>
                    <span className="font-medium">{k.label}</span> <span className="text-muted-foreground">{k.provider} · …{k.last4}</span>{" "}
                    <Badge variant={k.status === "valid" ? "success" : "warning"}>{k.status}</Badge>
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => removeKey(k)}>Remove</Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{keys.loading ? "Loading…" : keys.error ? keys.error.message : "No keys yet — bots use Workers AI."}</p>
          )}
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-1">
              <Label>Provider</Label>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={key.provider} onChange={(e) => setKey({ ...key, provider: e.target.value as ModelKeyProvider })}>
                {PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <Field label="Label" value={key.label} onChange={(v) => setKey({ ...key, label: v })} />
            <Field label="Key" type="password" value={key.key} onChange={(v) => setKey({ ...key, key: v })} />
            {key.provider === "openai-compatible" ? <Field label="Base URL (https)" value={key.baseUrl} onChange={(v) => setKey({ ...key, baseUrl: v })} /> : null}
          </div>
          <Button onClick={addKey} disabled={!key.key || savingKey}>{savingKey ? "Verifying…" : "Add key"}</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connectors (MCP)</CardTitle>
          <CardDescription>Remote MCP servers your bots can be granted tools from. Grant tools per bot on its Bot page.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {connectors.data && connectors.data.length > 0 ? (
            <ul className="divide-y rounded-md border">
              {connectors.data.map((s) => (
                <li key={s.id} className="space-y-1 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">{s.name}</span> <span className="text-muted-foreground">{s.url}</span>{" "}
                      <Badge variant={s.status === "active" ? "success" : "destructive"}>{s.status}</Badge> <Badge variant="outline">{s.authType}</Badge>
                    </span>
                    <span className="flex gap-1">
                      <Button variant="outline" size="sm" onClick={() => sync(s)}>Sync</Button>
                      <Button variant="ghost" size="sm" onClick={() => removeConnector(s)}>Remove</Button>
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">{s.tools.map((t) => t.name).join(" · ") || "no tools"}</div>
                  {s.lastError ? <div className="text-xs text-destructive">{s.lastError}</div> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{connectors.loading ? "Loading…" : connectors.error ? connectors.error.message : "No connectors yet."}</p>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name (slug)" value={mcp.name} onChange={(v) => setMcp({ ...mcp, name: v })} />
            <Field label="URL (https)" value={mcp.url} onChange={(v) => setMcp({ ...mcp, url: v })} />
            <Field label="Bearer token (optional)" type="password" value={mcp.token} onChange={(v) => setMcp({ ...mcp, token: v })} />
          </div>
          <Button onClick={addConnector} disabled={!mcp.name || !mcp.url || savingMcp}>{savingMcp ? "Connecting…" : "Add connector"}</Button>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  const id = React.useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
