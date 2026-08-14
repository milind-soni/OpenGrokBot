import { useEffect, useState } from "react";

import { api, useStore, type ConfigStatus } from "@/state/store";

export function OpenAIEndpointFields({ compact = false }: { compact?: boolean }) {
  const { state, dispatch } = useStore();
  const serverUrl = state.config?.openaiCompatible.url ?? "http://127.0.0.1:11434/v1";
  const serverModel = state.config?.openaiCompatible.model ?? "llama3.2";
  const [url, setUrl] = useState(serverUrl);
  const [model, setModel] = useState(serverModel);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(serverUrl);
    setModel(serverModel);
  }, [serverUrl, serverModel]);

  const save = () => {
    if (saving || !url.trim() || !model.trim()) return;
    setSaving(true);
    setError(null);
    api("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        openaiCompatible: { url: url.trim(), model: model.trim() },
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
      {!compact && <div className="mb-2 text-[13px] font-medium text-ink">Custom OpenAI-compatible endpoint</div>}
      <div className="mb-3 text-[12px] leading-relaxed text-ink-secondary">
        Local Ollama, a vLLM server on your LAN, or a remote service exposing <code>/v1/models</code> and{" "}
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
          placeholder="Model ID, e.g. qwen2.5-coder"
          aria-label="OpenAI-compatible default model ID"
          spellCheck={false}
          className={inputClass}
        />
        <button
          type="button"
          onClick={save}
          disabled={saving || !url.trim() || !model.trim()}
          className="self-end rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save endpoint"}
        </button>
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
