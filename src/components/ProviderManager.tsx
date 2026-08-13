import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/state/store";

type Preset = { label: string; baseUrl: string; requiresApiKey: boolean };
type Provider = {
  id: string; preset: string; label: string; baseUrl: string; requiresApiKey: boolean; configured: boolean;
  enabled: boolean; models: Array<{ id: string; label?: string }>; defaultModel: string; discoveredAt?: number; discoveryError?: string;
};

const inputClass = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none";

export function ProviderManager() {
  const [presets, setPresets] = useState<Record<string, Preset>>({});
  const [providers, setProviders] = useState<Provider[]>([]);
  const [preset, setPreset] = useState("openrouter");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [manualModel, setManualModel] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = presets[preset];

  const load = () => api("/api/providers").then((data) => {
    setPresets(data.presets ?? {});
    setProviders(data.providers ?? []);
  }).catch((reason) => setError(reason.message));

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (preset !== "custom" && selected) setBaseUrl(selected.baseUrl);
  }, [preset, selected]);

  const providerLabel = useMemo(() => preset === "custom" ? "Custom endpoint" : selected?.label ?? "Provider", [preset, selected]);
  const save = async () => {
    if (!baseUrl.trim()) return setError("Enter an endpoint URL.");
    setBusy("save"); setError(null);
    try {
      const body = { preset, baseUrl: baseUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(manualModel.trim() ? { manualModel: manualModel.trim() } : {}), ...(customLabel.trim() ? { label: customLabel.trim() } : {}) };
      const { provider } = await api("/api/providers", { method: "POST", body: JSON.stringify(body) });
      setApiKey("");
      if (provider.configured || !provider.requiresApiKey) await api(`/api/providers/${provider.id}/models/refresh`, { method: "POST" });
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(null); }
  };
  const refresh = async (id: string) => {
    setBusy(id); setError(null);
    try { await api(`/api/providers/${id}/models/refresh`, { method: "POST" }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(null); }
  };
  const remove = async (id: string) => {
    setBusy(id); setError(null);
    try { await api(`/api/providers/${id}`, { method: "DELETE" }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(null); }
  };

  return (
    <section className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Model providers</div>
      <p className="mt-0.5 text-[13px] text-ink-secondary">API providers are chat-only. Your key stays local; refresh finds live models without a hard-coded list.</p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <select value={preset} onChange={(event) => setPreset(event.target.value)} className={inputClass}>
          {Object.entries(presets).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}
          <option value="custom">Custom endpoint</option>
        </select>
        <input value={manualModel} onChange={(event) => setManualModel(event.target.value)} placeholder="Optional model ID" className={inputClass} />
      </div>
      {preset === "custom" && <input value={customLabel} onChange={(event) => setCustomLabel(event.target.value)} placeholder="Provider name" className={`mt-2 ${inputClass}`} />}
      <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://…/v1" className={`mt-2 ${inputClass}`} />
      {(preset === "custom" || selected?.requiresApiKey) && <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="API key (saved locally, never shown again)" autoComplete="off" className={`mt-2 ${inputClass}`} />}
      <button onClick={() => void save()} disabled={busy !== null} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
        <Plus size={14} /> {busy === "save" ? "Saving…" : `Add ${providerLabel}`}
      </button>
      {providers.length > 0 && <div className="mt-4 flex flex-col gap-2">
        {providers.map((provider) => <div key={provider.id} className="rounded-lg border border-hairline/40 bg-inset p-3">
          <div className="flex items-center justify-between gap-3"><div className="min-w-0"><div className="truncate text-[13px] font-medium text-ink">{provider.label}</div><div className="truncate text-[11px] text-ink-secondary">{provider.baseUrl}</div></div><span className={provider.configured ? "text-[11px] text-success" : "text-[11px] text-warning"}>{provider.configured ? "Ready" : "Needs key"}</span></div>
          <div className="mt-2 flex items-center justify-between gap-2"><span className="truncate text-[11px] text-ink-secondary">{provider.models.length ? `${provider.models.length} models · ${provider.defaultModel}` : provider.discoveryError ?? "No models yet"}</span><div className="flex gap-1"><button onClick={() => void refresh(provider.id)} disabled={busy !== null} title="Refresh models" className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"><RefreshCw size={14} className={busy === provider.id ? "animate-spin" : ""} /></button><button onClick={() => void remove(provider.id)} disabled={busy !== null} title="Remove provider" className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-danger"><Trash2 size={14} /></button></div></div>
          {provider.discoveryError && <div className="mt-1 text-[11px] text-warning">{provider.discoveryError}. Cached models were kept.</div>}
        </div>)}
      </div>}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </section>
  );
}
