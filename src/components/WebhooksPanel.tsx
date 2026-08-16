import { useMemo, useState } from "react";
import {
  Check,
  Cloud,
  Copy,
  ExternalLink,
  FlaskConical,
  KeyRound,
  Laptop,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCw,
  ShieldCheck,
  Trash2,
  Webhook,
  X,
} from "lucide-react";

import { MausAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import type { RoutineRunOn } from "@/lib/routines";
import type { WebhookCredential, WebhookTrigger, WebhookTriggerInput } from "@/lib/webhooks";
import { api, useStore, type Bot } from "@/state/store";

function relativeTime(at?: number) {
  if (!at) return "Waiting for its first delivery";
  const elapsed = Math.max(0, Date.now() - at);
  if (elapsed < 60_000) return "Received just now";
  if (elapsed < 60 * 60_000) return `Received ${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 24 * 60 * 60_000) return `Received ${Math.floor(elapsed / 3_600_000)}h ago`;
  return `Last received ${new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

function CredentialModal({
  credential,
  available,
  onClose,
}: {
  credential: WebhookCredential;
  available: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<"endpoint" | "secret" | "url" | "curl" | null>(null);
  const command = [
    "curl -X POST '" + credential.endpointUrl + "'",
    "-H 'Authorization: Bearer " + credential.secret + "'",
    "-H 'Content-Type: application/json'",
    "-H 'Idempotency-Key: event-123'",
    "-d '{\"event\":\"new_item\",\"id\":\"123\"}'",
  ].join(" \\\n  ");
  const copy = async (kind: "endpoint" | "secret" | "url" | "curl", value: string) => {
    await navigator.clipboard?.writeText(value);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1_800);
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="max-h-[90vh] w-full max-w-[650px] overflow-y-auto rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-hairline/40 px-5 py-4">
          <div>
            <div className="flex items-center gap-2 text-[17px] font-semibold text-ink"><ShieldCheck size={18} className="text-success" />Webhook connection ready</div>
            <div className="mt-1 text-[12px] text-ink-secondary">The secret is shown once. Treat it like a password.</div>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"><X size={18} /></button>
        </div>
        <div className="space-y-4 p-5">
          {!available && <div className="rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-3 text-[12px] leading-relaxed text-warning">The local receiver could not start. Save this URL, then restart OpenMausBot or change its webhook port before using it.</div>}
          <div className="rounded-xl border border-success/20 bg-success/5 p-3.5">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-success"><KeyRound size={13} />Recommended · header authentication</div>
            <div className="space-y-2">
              <div className="flex items-center gap-2 rounded-lg border border-hairline/40 bg-inset p-2">
                <div className="min-w-0 flex-1"><div className="px-2 text-[9px] uppercase tracking-wider text-ink-secondary">Endpoint</div><code className="block select-all overflow-x-auto px-2 pt-0.5 text-[11.5px] text-ink">{credential.endpointUrl}</code></div>
                <button onClick={() => void copy("endpoint", credential.endpointUrl)} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[12px] text-ink hover:bg-raised-hover">{copied === "endpoint" ? <Check size={13} className="text-success" /> : <Copy size={13} />}Copy</button>
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-hairline/40 bg-inset p-2">
                <div className="min-w-0 flex-1"><div className="px-2 text-[9px] uppercase tracking-wider text-ink-secondary">Bearer secret</div><code className="block select-all overflow-x-auto px-2 pt-0.5 text-[11.5px] text-ink">{credential.secret}</code></div>
                <button onClick={() => void copy("secret", credential.secret)} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[12px] text-ink hover:bg-raised-hover">{copied === "secret" ? <Check size={13} className="text-success" /> : <Copy size={13} />}Copy</button>
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary">Send the secret as <code className="text-ink">Authorization: Bearer …</code>. This keeps it out of request URLs and most access logs.</p>
          </div>
          <details className="rounded-xl border border-hairline/40 bg-inset px-3.5 py-3">
            <summary className="cursor-pointer text-[12px] font-medium text-ink">Show a test command</summary>
            <div className="relative mt-3 rounded-xl border border-hairline/50 bg-[#101010] p-3.5 pr-12">
              <pre className="overflow-x-auto whitespace-pre-wrap text-[11.5px] leading-relaxed text-ink-secondary">{command}</pre>
              <button onClick={() => void copy("curl", command)} className="absolute right-2 top-2 rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink" title="Copy curl command">{copied === "curl" ? <Check size={14} className="text-success" /> : <Copy size={14} />}</button>
            </div>
          </details>
          <details className="rounded-xl border border-hairline/40 bg-inset px-3.5 py-3">
            <summary className="cursor-pointer text-[12px] font-medium text-ink">Need one URL instead?</summary>
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-hairline/50 bg-panel p-2">
              <code className="min-w-0 flex-1 select-all overflow-x-auto px-2 text-[12px] text-ink">{credential.url}</code>
              <button onClick={() => void copy("url", credential.url)} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[12px] text-ink hover:bg-raised-hover">{copied === "url" ? <Check size={13} className="text-success" /> : <Copy size={13} />}Copy URL</button>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-secondary">For services that cannot send an Authorization header.</p>
          </details>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-hairline/40 px-5 py-4"><span className="text-[11px] text-ink-secondary">OpenMausBot must stay open to receive local events.</span><button onClick={onClose} className="rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110">Done</button></div>
      </div>
    </div>
  );
}

function WebhookEditor({ webhook, bots, onClose, onCredential }: { webhook?: WebhookTrigger; bots: Bot[]; onClose: () => void; onCredential: (credential: WebhookCredential) => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(webhook?.name ?? "");
  const [prompt, setPrompt] = useState(webhook?.prompt ?? "");
  const [botId, setBotId] = useState(webhook?.botId ?? bots[0]?.id ?? "");
  const [runOn, setRunOn] = useState<RoutineRunOn>(webhook?.runOn ?? "maus");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const cloudInstance = state.instances.find((instance) => instance.driverKind === "boxAgent");
  const cloudReady = Boolean(state.config?.box.configured && cloudInstance?.snapshot.state === "available");

  const save = async () => {
    const input: WebhookTriggerInput = { name, prompt, botId, runOn, enabled: webhook?.enabled ?? true };
    setSaving(true);
    setError("");
    try {
      const response = await api(webhook ? `/api/webhooks/${webhook.id}` : "/api/webhooks", {
        method: webhook ? "PATCH" : "POST",
        body: JSON.stringify(input),
      });
      dispatch({ type: "webhookPatched", webhook: response.webhook });
      onClose();
      if (response.credential) onCredential(response.credential);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="flex max-h-[90vh] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-hairline/40 bg-panel/95 px-5 py-4">
          <div><div className="text-[17px] font-semibold text-ink">{webhook ? "Edit webhook" : "New webhook"}</div><div className="mt-0.5 text-[12px] text-ink-secondary">Turn an event from another app into a MAUS task.</div></div>
          <button onClick={onClose} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"><X size={18} /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <label className="block"><span className="mb-1.5 block text-[12px] font-medium text-ink-secondary">Webhook name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="New support ticket" className="w-full rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70" /></label>
          <div>
            <div className="mb-2 text-[12px] font-medium text-ink-secondary">Who handles it?</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {bots.map((bot) => <button key={bot.id} type="button" onClick={() => setBotId(bot.id)} className={cn("flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2 text-left", botId === bot.id ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60")}><MausAvatar color={bot.color} state={botId === bot.id ? "happy" : "idle"} size={38} animated={false} /><span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{bot.name}</span></button>)}
            </div>
          </div>
          <div>
            <div className="mb-2 text-[12px] font-medium text-ink-secondary">Where does it run?</div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setRunOn("maus")} className={cn("rounded-xl border p-3 text-left", runOn === "maus" ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60")}><div className="flex items-center gap-2 text-[13px] font-medium text-ink"><Laptop size={15} />MAUS setup</div><div className="mt-1 text-[11px] text-ink-secondary">Uses this MAUS's model and computer.</div></button>
              <button type="button" disabled={!cloudReady && runOn !== "cloud"} onClick={() => setRunOn("cloud")} className={cn("rounded-xl border p-3 text-left disabled:cursor-not-allowed disabled:opacity-45", runOn === "cloud" ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60")}><div className="flex items-center gap-2 text-[13px] font-medium text-ink"><Cloud size={15} />Cloud VM</div><div className="mt-1 text-[11px] text-ink-secondary">Runs the MAUS inside its Box VM.</div></button>
            </div>
          </div>
          <label className="block"><span className="mb-1.5 block text-[12px] font-medium text-ink-secondary">What should this MAUS do?</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} placeholder="Read the incoming ticket data, investigate the issue, and prepare a response…" className="w-full resize-y rounded-xl border border-hairline/60 bg-inset px-3.5 py-3 text-[14px] leading-relaxed text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70" /><span className="mt-1.5 block text-[11px] leading-relaxed text-ink-secondary">The event is attached as untrusted data. Good for support tickets, failed builds, forms, orders, and alerts.</span></label>
          {error && <div className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12px] text-danger">{error}</div>}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-hairline/40 px-5 py-4"><button onClick={onClose} className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">Cancel</button><button disabled={saving || !name.trim() || !prompt.trim() || !botId} onClick={() => void save()} className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40">{saving && <Loader2 size={14} className="animate-spin" />}{webhook ? "Save changes" : "Create webhook"}</button></div>
      </div>
    </div>
  );
}

export function WebhooksPanel({ bots }: { bots: Bot[] }) {
  const { state, dispatch } = useStore();
  const [editor, setEditor] = useState<WebhookTrigger | "new" | null>(null);
  const [credential, setCredential] = useState<WebhookCredential | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const runById = useMemo(() => new Map(state.routineRuns.map((run) => [run.id, run])), [state.routineRuns]);

  const invoke = async (webhook: WebhookTrigger, action: "test" | "rotate" | "toggle" | "delete") => {
    setWorking(`${webhook.id}:${action}`);
    setError("");
    try {
      if (action === "delete") {
        if (!window.confirm(`Delete “${webhook.name}”? Existing run receipts will stay in the calendar.`)) return;
        await api(`/api/webhooks/${webhook.id}`, { method: "DELETE" });
        dispatch({ type: "webhookDeleted", webhookId: webhook.id });
      } else if (action === "toggle") {
        const response = await api(`/api/webhooks/${webhook.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !webhook.enabled }) });
        dispatch({ type: "webhookPatched", webhook: response.webhook });
      } else if (action === "rotate") {
        if (!window.confirm("Generate a new secret URL? The previous URL will stop working immediately.")) return;
        const response = await api(`/api/webhooks/${webhook.id}/rotate`, { method: "POST" });
        dispatch({ type: "webhookPatched", webhook: response.webhook });
        setCredential(response.credential);
      } else {
        await api(`/api/webhooks/${webhook.id}/test`, { method: "POST", body: JSON.stringify({ event: "openmaus.test", message: `Test delivery for ${webhook.name}` }) });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(null);
    }
  };

  const ingress = state.webhookIngress;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto border-t border-hairline/40 p-5 md:p-6">
      <div className="mx-auto max-w-[1100px] space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><h2 className="text-[16px] font-semibold text-ink">Webhook triggers</h2><p className="mt-1 text-[12px] text-ink-secondary">Start a MAUS when another app sends an event.</p></div>
          <button onClick={() => setEditor("new")} disabled={bots.length === 0} className="flex items-center gap-2 rounded-xl bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40"><Plus size={15} />New webhook</button>
        </div>
        {!ingress?.available && ingress?.error && <div role="alert" className="rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-3 text-[12px] text-warning">{ingress.error}</div>}
        {error && <div className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12px] text-danger">{error}</div>}

        {state.webhooks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-hairline/60 bg-panel/50 px-6 py-12 text-center">
            <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Webhook size={30} /></div>
            <h3 className="text-[16px] font-semibold text-ink">React the moment something happens</h3>
            <p className="mx-auto mt-2 max-w-[480px] text-[12.5px] leading-relaxed text-ink-secondary">Triage a new support ticket, investigate a failed build, summarize a form submission, or react to an order—right when it happens.</p>
            <button onClick={() => setEditor("new")} disabled={bots.length === 0} className="mt-5 inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40"><Plus size={15} />Create your first webhook</button>
            {bots.length === 0 && <p className="mt-3 text-[12px] text-warning">Create a MAUS first, then come back to connect a webhook.</p>}
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {state.webhooks.map((webhook) => {
              const bot = bots.find((candidate) => candidate.id === webhook.botId);
              const run = webhook.lastRunId ? runById.get(webhook.lastRunId) : undefined;
              const busy = working?.startsWith(`${webhook.id}:`);
              return (
                <div key={webhook.id} className={cn("rounded-2xl border bg-panel p-4 shadow-lg shadow-black/5", webhook.enabled ? "border-hairline/50" : "border-hairline/30 opacity-65")}>
                  <div className="flex items-start gap-3">
                    {bot ? <MausAvatar color={bot.color} state={run?.status === "running" ? "working" : webhook.enabled ? "idle" : "sleeping"} size={50} animated={run?.status === "running"} label={bot.name} /> : <div className="flex size-[50px] items-center justify-center rounded-xl bg-raised text-ink-secondary"><Webhook size={22} /></div>}
                    <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h3 className="truncate text-[14px] font-semibold text-ink">{webhook.name}</h3><span className={cn("size-2 shrink-0 rounded-full", webhook.enabled ? "bg-success" : "bg-ink-secondary/40")} /></div><div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-secondary"><span>{bot?.name ?? "Deleted MAUS"}</span><span>·</span><span className="flex items-center gap-1">{webhook.runOn === "cloud" ? <Cloud size={11} /> : <Laptop size={11} />}{webhook.runOn === "cloud" ? "Cloud VM" : "MAUS setup"}</span><span>·</span><span>{relativeTime(webhook.lastReceivedAt)}</span>{webhook.deliveryCount > 0 && <><span>·</span><span>{webhook.deliveryCount} {webhook.deliveryCount === 1 ? "delivery" : "deliveries"}</span></>}</div></div>
                    {busy && <Loader2 size={15} className="animate-spin text-accent" />}
                  </div>
                  <p className="mt-3 line-clamp-2 text-[12px] leading-relaxed text-ink-secondary">{webhook.prompt}</p>
                  {run && <div className="mt-3 flex items-center justify-between rounded-xl border border-hairline/35 px-3 py-2 text-[11.5px]"><span className="text-ink-secondary">Latest delivery</span><span className={cn("font-medium capitalize", run.status === "failed" ? "text-danger" : run.status === "completed" ? "text-success" : "text-accent")}>{run.status.replace("waiting", "needs you")}</span></div>}
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <button disabled={busy || !webhook.enabled} onClick={() => void invoke(webhook, "test")} className="flex items-center gap-1.5 rounded-lg bg-raised px-2.5 py-1.5 text-[11.5px] text-ink hover:bg-raised-hover disabled:opacity-40"><FlaskConical size={12} />Test</button>
                    {run?.threadId && bot && <button onClick={() => { dispatch({ type: "select", id: bot.id }); dispatch({ type: "switchTask", botId: bot.id, threadId: run.threadId! }); }} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] text-ink-secondary hover:bg-raised hover:text-ink"><ExternalLink size={12} />Open run</button>}
                    <button disabled={busy} onClick={() => setEditor(webhook)} className="rounded-lg px-2.5 py-1.5 text-[11.5px] text-ink-secondary hover:bg-raised hover:text-ink">Edit</button>
                    <button disabled={busy} onClick={() => void invoke(webhook, "rotate")} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] text-ink-secondary hover:bg-raised hover:text-ink"><RotateCw size={12} />New URL</button>
                    <div className="flex-1" />
                    <button disabled={busy} onClick={() => void invoke(webhook, "toggle")} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink" title={webhook.enabled ? "Pause webhook" : "Resume webhook"}>{webhook.enabled ? <Pause size={13} /> : <Play size={13} />}</button>
                    <button disabled={busy} onClick={() => void invoke(webhook, "delete")} className="rounded-lg p-2 text-ink-secondary hover:bg-danger/10 hover:text-danger" title="Delete webhook"><Trash2 size={13} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {editor && <WebhookEditor webhook={editor === "new" ? undefined : editor} bots={bots} onClose={() => setEditor(null)} onCredential={setCredential} />}
      {credential && <CredentialModal credential={credential} available={Boolean(ingress?.available)} onClose={() => setCredential(null)} />}
    </div>
  );
}
