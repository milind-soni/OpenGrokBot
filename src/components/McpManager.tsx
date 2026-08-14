import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";

type Inspection = { ok: boolean; message?: string; tools?: Array<{ name: string }> };

export function McpManager() {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Inspection>>({});
  const servers = state.config?.mcp?.servers ?? [];

  const refresh = () => api("/api/config").then((config: ConfigStatus) => dispatch({ type: "configStatus", config }));
  const save = async () => {
    setError(null);
    setBusy("new");
    try {
      await api("/api/mcp/servers", {
        method: "POST",
        body: JSON.stringify({ name, transport, ...(transport === "stdio" ? { command, args: [] } : { url }) }),
      });
      setName("");
      setCommand("");
      setUrl("");
      setOpen(false);
      await refresh();
    } catch {
      setError("Could not add MCP server");
    } finally { setBusy(null); }
  };
  const update = async (id: string, patch: unknown) => {
    setError(null);
    setBusy(id);
    try { await api(`/api/mcp/servers/${id}`, { method: "PATCH", body: JSON.stringify(patch) }); await refresh(); }
    catch { setError("Could not update MCP server"); }
    finally { setBusy(null); }
  };
  const remove = async (id: string) => {
    setError(null);
    setBusy(id);
    try { await api(`/api/mcp/servers/${id}`, { method: "DELETE" }); await refresh(); }
    catch { setError("Could not remove MCP server"); }
    finally { setBusy(null); }
  };
  const inspect = async (id: string) => {
    setError(null);
    setBusy(id);
    try {
      const result = await api(`/api/mcp/servers/${id}/inspect`, { method: "POST" }) as Inspection;
      setResults((old) => ({ ...old, [id]: result }));
    }
    catch { setResults((old) => ({ ...old, [id]: { ok: false, message: "Inspection failed" } })); }
    finally { setBusy(null); }
  };

  return <div className="mt-4 rounded-xl bg-card p-4">
    <div className="flex items-start justify-between gap-3">
      <div><div className="text-[15px] font-medium text-ink">MCP servers</div><div className="mt-0.5 text-[13px] text-ink-secondary">Local tools for compatible CLI agents. Secrets stay on this device.</div></div>
      <button onClick={() => setOpen((value) => !value)} className="rounded-lg bg-raised p-2 text-ink hover:bg-raised-hover" title="Add MCP server"><Plus size={16} /></button>
    </div>
    {open && <div className="mt-3 flex flex-col gap-2 rounded-lg border border-hairline/40 bg-inset p-3">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Server name" className="rounded-md border border-hairline/40 bg-card px-2.5 py-2 text-[13px] text-ink" />
      <select value={transport} onChange={(e) => setTransport(e.target.value as "stdio" | "http")} className="rounded-md border border-hairline/40 bg-card px-2.5 py-2 text-[13px] text-ink"><option value="stdio">Local stdio</option><option value="http">Remote HTTP</option></select>
      {transport === "stdio" ? <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Command, e.g. npx" className="rounded-md border border-hairline/40 bg-card px-2.5 py-2 text-[13px] text-ink" /> : <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" className="rounded-md border border-hairline/40 bg-card px-2.5 py-2 text-[13px] text-ink" />}
      <button disabled={busy === "new" || !name.trim() || !(transport === "stdio" ? command.trim() : url.trim())} onClick={() => void save()} className="rounded-md bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50">{busy === "new" ? "Adding…" : "Add server"}</button>
    </div>}
    {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    <div className="mt-3 flex flex-col gap-2">
      {servers.length === 0 && <div className="rounded-lg bg-inset px-3 py-2.5 text-[13px] text-ink-secondary">No MCP servers yet. Add a local command or an HTTPS endpoint.</div>}
      {servers.map((server) => <div key={server.id} className="rounded-lg bg-inset px-3 py-2.5">
        <div className="flex items-center justify-between gap-2"><div><div className="text-[13px] font-medium text-ink">{server.name}</div><div className="text-[11px] text-ink-secondary">{server.transport === "stdio" ? "Local stdio" : server.url} · {server.assignedBotIds.length ? `${server.assignedBotIds.length} assigned` : "All bots"}</div></div><div className="flex items-center gap-1"><button disabled={busy === server.id} onClick={() => void inspect(server.id)} title="Test server" className="rounded p-1.5 text-ink-secondary hover:bg-raised"><RefreshCw size={14} /></button><button disabled={busy === server.id} onClick={() => void update(server.id, { enabled: !server.enabled })} className="rounded px-1.5 py-1 text-[11px] text-ink-secondary hover:bg-raised">{server.enabled ? "On" : "Off"}</button><button disabled={busy === server.id} onClick={() => void remove(server.id)} title="Remove server" className="rounded p-1.5 text-danger hover:bg-raised"><Trash2 size={14} /></button></div></div>
        {busy === server.id && <Loader2 size={13} className="mt-2 animate-spin text-ink-secondary" />}
        {results[server.id] && <div className={results[server.id].ok ? "mt-2 text-[11px] text-success" : "mt-2 text-[11px] text-danger"}>{results[server.id].ok ? `Healthy${results[server.id].tools?.length ? ` · ${results[server.id].tools!.map((tool) => tool.name).join(", ")}` : ""}` : results[server.id].message}</div>}
      </div>)}
    </div>
  </div>;
}
