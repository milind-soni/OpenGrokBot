// Ollama driver — local LLM via the Ollama REST API (default
// http://127.0.0.1:11434). Unlike the CLI drivers this is transcript-replay:
// the server hands it the folded thread history each turn and it emits
// true token-level content.delta events. Model catalog is fetched
// dynamically from GET /api/tags so whatever models the user has pulled
// appear automatically. Also supplies generateText for bot titles /
// thread names.
import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  ModelCatalog,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "ollama";
const DEFAULT_URL = "http://127.0.0.1:11434";

export interface OllamaConfig {
  url: string;
  /** Env var name that holds an optional bearer token (for remote Ollama
   * instances behind a proxy). Empty = no auth. */
  apiKeyEnv: string;
}

function decodeConfig(raw: unknown): OllamaConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    url: typeof o.url === "string" ? o.url : DEFAULT_URL,
    apiKeyEnv: typeof o.apiKeyEnv === "string" ? o.apiKeyEnv : "OLLAMA_API_KEY",
  };
}

// Fallback catalog used when /api/tags is unreachable at boot — the
// driver still loads and the snapshot explains the situation.
const FALLBACK_MODELS: ModelCatalog = {
  default: "llama3.2",
  options: [
    { id: "llama3.2", label: "Llama 3.2" },
    { id: "llama3.1", label: "Llama 3.1" },
    { id: "qwen2.5", label: "Qwen 2.5" },
    { id: "mistral", label: "Mistral" },
    { id: "phi3", label: "Phi-3" },
  ],
};

/** Pretty-print an Ollama model tag for the model picker. */
function modelLabel(id: string): string {
  // "llama3.2:latest" → "Llama 3.2"
  const base = id.replace(/:latest$/, "").replace(/:[\w.-]+$/, (tag) => ` (${tag.slice(1)})`);
  return base
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Fetch the live model list from Ollama. Returns null on failure. */
async function fetchModels(baseUrl: string, apiKey: string): Promise<ModelCatalog | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl}/api/tags`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const json: any = await res.json();
  const names: string[] = (json.models ?? [])
    .map((m: any) => m.name ?? m.model)
    .filter(Boolean);
  if (!names.length) return null;
  // Deduplicate and sort
  const unique = [...new Set(names)].sort();
  return {
    default: unique[0],
    options: unique.map((id) => ({ id, label: modelLabel(id) })),
  };
}

export const OllamaDriver: ProviderDriver<OllamaConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Ollama", supportsMultipleInstances: true },
  models: FALLBACK_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<OllamaConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();

    // Live model catalog — refreshed on create and on each snapshot.
    let liveModels: ModelCatalog | null = null;
    try {
      liveModels = await fetchModels(config.url, apiKey);
    } catch {
      // server not running yet — the snapshot will explain
    }
    const models = liveModels ?? FALLBACK_MODELS;

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    // ── core chat completion (Ollama /api/chat, NDJSON streaming) ──────
    const complete = async (
      messages: Array<{ role: string; content: string }>,
      model: string,
      opts: { stream: boolean; signal?: AbortSignal; onDelta?: (d: string) => void },
    ): Promise<{ text: string; usage: { input: number; output: number } | null }> => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const res = await fetch(`${config.url}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages, stream: opts.stream }),
        signal: opts.signal ?? AbortSignal.timeout(300_000), // local models can be slow
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Ollama HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }

      if (!opts.stream) {
        const json: any = await res.json();
        return {
          text: json.message?.content ?? "",
          usage: json.eval_count
            ? { input: json.prompt_eval_count ?? 0, output: json.eval_count ?? 0 }
            : null,
        };
      }

      // Ollama streams NDJSON: one JSON object per line, each with a
      // `message.content` delta. The final line has `done: true`.
      let text = "";
      let usage: { input: number; output: number } | null = null;
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let chunk: any;
          try {
            chunk = JSON.parse(line);
          } catch {
            continue;
          }
          const delta = chunk.message?.content;
          if (delta) {
            text += delta;
            opts.onDelta?.(delta);
          }
          if (chunk.done) {
            usage = {
              input: chunk.prompt_eval_count ?? 0,
              output: chunk.eval_count ?? 0,
            };
          }
        }
      }
      return { text, usage };
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const abort = new AbortController();
      active.set(threadId, { abort, turnId });

      const model = turn.model || models.default;
      const messages = [
        ...(turn.system ? [{ role: "system", content: turn.system }] : []),
        ...(turn.transcript ?? []).map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.text,
        })),
        { role: "user", content: turn.text },
      ];
      appendNative(threadId, { dir: "out", source: "ollama.chat", msg: { model, messages } });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model });

      (async () => {
        try {
          const { text, usage } = await complete(messages, model, {
            stream: true,
            signal: abort.signal,
            onDelta: (delta) =>
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta }),
          });
          appendNative(threadId, { dir: "in", source: "ollama.chat", msg: { text, usage } });
          if (text.trim()) {
            emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
          }
          if (usage) {
            emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...usage });
          }
          active.delete(threadId);
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
        } catch (e) {
          active.delete(threadId);
          const aborted = (e as Error).name === "AbortError";
          if (!aborted) {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
          }
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: false,
            stopReason: aborted ? "interrupted" : "error",
            cost: null,
          });
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      try {
        // refresh the model list opportunistically
        const fresh = await fetchModels(config.url, apiKey);
        if (fresh) {
          liveModels = fresh;
          // mutate the instance's models in place so the picker updates
          (instance as any).models = fresh;
        }
      } catch {
        // server not running — report unavailable
      }
      if (!liveModels) {
        return {
          state: "unavailable",
          reason: `Ollama not reachable at ${config.url} — is it running? (ollama serve)`,
        };
      }
      return { state: "available", authenticated: true, version: null };
    };

    const instance: ProviderInstance = {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        respondToRequest: async () => {
          throw new Error("ollama driver has no pending asks");
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { abort } of active.values()) abort.abort();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt: string) => {
        // Use a small/fast model if available, else the default
        const smallModel = models.options.find((o) =>
          /phi|mini|small|tiny|qwen.*0\.5|qwen.*1\.5/i.test(o.id),
        )?.id;
        const { text } = await complete(
          [{ role: "user", content: prompt }],
          smallModel ?? models.default,
          { stream: false },
        );
        return text;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };

    return instance;
  },
};