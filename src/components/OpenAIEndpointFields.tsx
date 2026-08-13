import { useEffect, useState } from "react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { formatModelTaskOverrides, parseModelTaskOverrides } from "@/lib/model-tasks";

export function OpenAIEndpointFields({ compact = false }: { compact?: boolean }) {
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
    if (!compact && parsed.error) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    const endpoint = compact
      ? { url: url.trim(), model: model.trim() }
      : {
          url: url.trim(),
          model: model.trim(),
          modelTasks: parsed.tasks,
          imagePath: imagePath.trim(),
          videoPath: videoPath.trim(),
        };
    api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ openaiCompatible: endpoint }),
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
        {!compact && (
          <>
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
          </>
        )}
        <button
          onClick={save}
          disabled={saving || !url.trim() || !model.trim() || (!compact && (!imagePath.trim() || !videoPath.trim()))}
          className="self-end rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save endpoint"}
        </button>
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
