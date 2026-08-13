// App-level settings, in the right-side slot: who you are + credentials
// shared by all bots. Per-bot settings (name, persona, model, computer)
// live in SettingsPanel; contextual Box-token entry stays in ComputerPanel.
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { ApiKeyRow } from "./ApiKeys";
import { useUpdaterState } from "@/lib/updater";
import { formatModelTaskOverrides, parseModelTaskOverrides } from "@/lib/model-tasks";

/** Name + email, persisted to /api/config {profile} on blur. Prefilled from
 * the current config (the values are echoed back — they're not secrets). */
function ProfileFields() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  // adopt late-arriving config exactly once per open (config loads async)
  useEffect(() => {
    setName(state.config?.profile?.name ?? "");
    setEmail(state.config?.profile?.email ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.config?.profile?.name, state.config?.profile?.email]);

  const save = () => {
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
    })
      .then((r) => r.json())
      .then((config) => dispatch({ type: "configStatus", config }))
      .catch(() => {});
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  return (
    <div className="flex flex-col gap-3">
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={save} placeholder="Your name" className={inputClass} />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={save}
        placeholder="you@example.com"
        className={inputClass}
      />
    </div>
  );
}

/** Non-secret connection coordinates for a local/LAN/remote OpenAI-style
 * server. The optional bearer token is handled by the write-only key row. */
function OpenAIEndpointFields() {
  const { state, dispatch } = useStore();
  const [url, setUrl] = useState(state.config?.openaiCompatible.url ?? "http://127.0.0.1:11434/v1");
  const [model, setModel] = useState(state.config?.openaiCompatible.model ?? "gpt-oss:20b");
  const [imagePath, setImagePath] = useState(state.config?.openaiCompatible.imagePath ?? "/images/generations");
  const [videoPath, setVideoPath] = useState(state.config?.openaiCompatible.videoPath ?? "/videos");
  const [modelTasks, setModelTasks] = useState(() =>
    formatModelTaskOverrides(state.config?.openaiCompatible.modelTasks ?? {}),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.config) return;
    setUrl(state.config.openaiCompatible.url);
    setModel(state.config.openaiCompatible.model);
    setImagePath(state.config.openaiCompatible.imagePath);
    setVideoPath(state.config.openaiCompatible.videoPath);
    setModelTasks(formatModelTaskOverrides(state.config.openaiCompatible.modelTasks));
  }, [
    state.config?.openaiCompatible.url,
    state.config?.openaiCompatible.model,
    state.config?.openaiCompatible.imagePath,
    state.config?.openaiCompatible.videoPath,
    state.config?.openaiCompatible.modelTasks,
  ]);

  const save = () => {
    if (saving) return;
    if (!url.trim() || !model.trim()) {
      setError("Base URL and model ID are required.");
      return;
    }
    const parsed = parseModelTaskOverrides(modelTasks);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    api("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        openaiCompatible: {
          url: url.trim(),
          model: model.trim(),
          modelTasks: parsed.tasks,
          imagePath: imagePath.trim(),
          videoPath: videoPath.trim(),
        },
      }),
    })
      .then((config: ConfigStatus) => dispatch({ type: "configStatus", config }))
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setSaving(false));
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  return (
    <div>
      <div className="mb-2 text-[13px] font-medium text-ink">Custom OpenAI-compatible endpoint</div>
      <div className="mb-3 text-[12px] leading-relaxed text-ink-secondary">
        Local Ollama, a vLLM server on your LAN, or any remote service exposing <code>/v1/models</code> and{" "}
        <code>/v1/chat/completions</code>.
      </div>
      <div className="flex flex-col gap-2">
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && save()}
          placeholder="http://192.168.1.25:8000/v1"
          aria-label="OpenAI-compatible base URL"
          spellCheck={false}
          className={inputClass}
        />
        <input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && save()}
          placeholder="Model ID, e.g. gpt-oss:20b"
          aria-label="OpenAI-compatible default model ID"
          spellCheck={false}
          className={inputClass}
        />
        <div className="mt-1 grid grid-cols-2 gap-2">
          <label className="text-[11px] text-ink-secondary">
            Image path
            <input
              value={imagePath}
              onChange={(event) => setImagePath(event.target.value)}
              placeholder="/images/generations"
              aria-label="Image generation path"
              spellCheck={false}
              className={`${inputClass} mt-1`}
            />
          </label>
          <label className="text-[11px] text-ink-secondary">
            Video path
            <input
              value={videoPath}
              onChange={(event) => setVideoPath(event.target.value)}
              placeholder="/videos"
              aria-label="Video generation path"
              spellCheck={false}
              className={`${inputClass} mt-1`}
            />
          </label>
        </div>
        <label className="mt-1 text-[11px] text-ink-secondary">
          Model task overrides
          <textarea
            value={modelTasks}
            onChange={(event) => setModelTasks(event.target.value)}
            rows={3}
            placeholder={"stable-diffusion-xl=image\nwan-2.2=video"}
            aria-label="Model task overrides"
            spellCheck={false}
            className={`${inputClass} mt-1 resize-y font-mono`}
          />
        </label>
        <div className="text-[11px] leading-relaxed text-ink-secondary">
          Add one <code>model=chat|image|video</code> entry per line when the server's model catalog does not report output capabilities.
        </div>
        <button
          onClick={save}
          disabled={saving || !url.trim() || !model.trim() || !imagePath.trim() || !videoPath.trim()}
          className="self-end rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save endpoint"}
        </button>
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

/** Manual update check row — packaged app only (no bridge in dev). */
function UpdatesRow() {
  const s = useUpdaterState();
  if (!window.ogb?.updater) return null;
  const updater = window.ogb.updater;
  const label =
    s?.status === "checking"
      ? "Checking…"
      : s?.status === "available"
        ? `${s.version} available`
        : s?.status === "downloading"
          ? `Downloading… ${Math.round(s.percent ?? 0)}%`
          : s?.status === "downloaded"
            ? `${s.version} ready — restart to apply`
            : s?.status === "error"
              ? `Check failed: ${s.message ?? "unknown error"}`
              : "You're on the latest version we know of.";
  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">App updates</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{label}</div>
      <div className="mt-3 flex gap-2">
        {s?.status === "available" ? (
          <button
            onClick={() => void updater.download()}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white"
          >
            Download
          </button>
        ) : s?.status === "downloaded" ? (
          <button
            onClick={() => void updater.install()}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white"
          >
            Restart to update
          </button>
        ) : (
          <button
            onClick={() => void updater.check()}
            disabled={s?.status === "checking" || s?.status === "downloading"}
            className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"
          >
            Check for updates
          </button>
        )}
      </div>
    </div>
  );
}

export function AppSettingsPanel() {
  const { dispatch } = useStore();

  return (
    <aside className="animate-panel-in flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="w-6" />
        <span className="text-[15px] font-semibold text-ink">App Settings</span>
        <button
          onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <div className="mt-2 rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">Profile</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">Shown in the sidebar. Saved as you go.</div>
          <div className="mt-4">
            <ProfileFields />
          </div>
        </div>

        <div className="mt-4 rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">Model providers</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Keys stay on this computer. Provider model lists are discovered automatically after connecting.
          </div>
          <div className="mt-4 flex flex-col gap-4">
            <ApiKeyRow section="openrouter" label="OpenRouter API key" placeholder="sk-or-v1-…" />
            <ApiKeyRow section="ollamaCloud" label="Ollama Cloud API key" placeholder="Ollama API key" />
            <div className="border-t border-hairline/40 pt-4">
              <OpenAIEndpointFields />
            </div>
            <ApiKeyRow
              section="openaiCompatible"
              label="Endpoint bearer token (optional)"
              placeholder="Not needed for local Ollama"
            />
          </div>
        </div>

        <div className="mt-4 rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">Connections</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Shared by all bots. Saving a key reloads providers instantly; keys are stored locally and never
            shown again.
          </div>
          <div className="mt-4 flex flex-col gap-4">
            <ApiKeyRow section="composio" label="Composio Connect key" placeholder="ck_…" />
            <ApiKeyRow
              section="composioApi"
              label="Composio API key (optional)"
              placeholder="ak_…  unlocks the full app catalog"
            />
            <ApiKeyRow section="box" label="Box token" placeholder="Token from box.ascii.dev" />
          </div>
        </div>

        <UpdatesRow />
      </div>
    </aside>
  );
}
