import { useEffect, useState } from "react";

import { api, useStore, type ConfigStatus } from "@/state/store";

export function OpenAIEndpointFields({ compact = false }: { compact?: boolean }) {
  const { state, dispatch } = useStore();
  const serverUrl = state.config?.openaiCompatible.url ?? "http://127.0.0.1:11434/v1";
  const serverModel = state.config?.openaiCompatible.model ?? "llama3.2";
  const serverTasks = state.config?.openaiCompatible.modelTasks ?? {};
  const serverImageModel = Object.entries(serverTasks).find(([, task]) => task === "image")?.[0] ?? "";
  const serverVideoModel = Object.entries(serverTasks).find(([, task]) => task === "video")?.[0] ?? "";
  const serverImagePath = state.config?.openaiCompatible.imagePath ?? "/images/generations";
  const serverVideoPath = state.config?.openaiCompatible.videoPath ?? "/videos";
  const [url, setUrl] = useState(serverUrl);
  const [model, setModel] = useState(serverModel);
  const [imageModel, setImageModel] = useState(serverImageModel);
  const [videoModel, setVideoModel] = useState(serverVideoModel);
  const [imagePath, setImagePath] = useState(serverImagePath);
  const [videoPath, setVideoPath] = useState(serverVideoPath);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(serverUrl);
    setModel(serverModel);
    setImageModel(serverImageModel);
    setVideoModel(serverVideoModel);
    setImagePath(serverImagePath);
    setVideoPath(serverVideoPath);
  }, [serverUrl, serverModel, serverImageModel, serverVideoModel, serverImagePath, serverVideoPath]);

  const save = () => {
    if (saving || !url.trim() || !model.trim()) return;
    setSaving(true);
    setError(null);
    api("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        openaiCompatible: {
          url: url.trim(),
          model: model.trim(),
          ...(!compact ? {
            modelTasks: {
              ...(imageModel.trim() ? { [imageModel.trim()]: "image" } : {}),
              ...(videoModel.trim() ? { [videoModel.trim()]: "video" } : {}),
            },
            imagePath: imagePath.trim(),
            videoPath: videoPath.trim(),
          } : {}),
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
        {!compact && (
          <div className="mt-2 rounded-lg border border-hairline/40 bg-panel/60 p-3">
            <div className="mb-1 text-[12px] font-medium text-ink">Optional media endpoints</div>
            <div className="mb-2 text-[11px] leading-relaxed text-ink-secondary">
              Add model IDs your endpoint uses for images or video. Routes must stay on this base URL.
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={imageModel}
                onChange={(event) => setImageModel(event.target.value)}
                placeholder="Image model ID"
                aria-label="OpenAI-compatible image model ID"
                spellCheck={false}
                className={inputClass}
              />
              <input
                value={imagePath}
                onChange={(event) => setImagePath(event.target.value)}
                placeholder="/images/generations"
                aria-label="OpenAI-compatible image route"
                spellCheck={false}
                className={inputClass}
              />
              <input
                value={videoModel}
                onChange={(event) => setVideoModel(event.target.value)}
                placeholder="Video model ID"
                aria-label="OpenAI-compatible video model ID"
                spellCheck={false}
                className={inputClass}
              />
              <input
                value={videoPath}
                onChange={(event) => setVideoPath(event.target.value)}
                placeholder="/videos"
                aria-label="OpenAI-compatible video route"
                spellCheck={false}
                className={inputClass}
              />
            </div>
          </div>
        )}
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
