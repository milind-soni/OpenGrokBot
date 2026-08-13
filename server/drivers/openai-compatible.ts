import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { normalizeProviderBaseUrl } from "../providers.ts";

const DRIVER_KIND = "openaiCompatible";
const TURN_TIMEOUT_MS = 120_000;

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKeyEnv: string;
  requiresApiKey: boolean;
  models: Array<{ id: string; label?: string }>;
  defaultModel?: string;
}

function decodeConfig(raw: unknown): OpenAICompatibleConfig {
  const value = (raw ?? {}) as Record<string, unknown>;
  const models = Array.isArray(value.models)
    ? value.models.flatMap((model) => {
        const item = model as Record<string, unknown>;
        return typeof item.id === "string" && item.id.trim()
          ? [{ id: item.id.trim(), ...(typeof item.label === "string" ? { label: item.label.trim() } : {}) }]
          : [];
      })
    : [];
  return {
    baseUrl: normalizeProviderBaseUrl(value.baseUrl),
    apiKeyEnv: typeof value.apiKeyEnv === "string" && value.apiKeyEnv ? value.apiKeyEnv : "OPENAI_COMPAT_API_KEY",
    requiresApiKey: value.requiresApiKey !== false,
    models,
    ...(typeof value.defaultModel === "string" && value.defaultModel.trim() ? { defaultModel: value.defaultModel.trim() } : {}),
  };
}

function catalog(config: OpenAICompatibleConfig): ModelCatalog {
  const options = config.models.map((model) => ({ id: model.id, label: model.label || model.id }));
  const defaultModel = config.defaultModel || options[0]?.id || "";
  if (defaultModel && !options.some((model) => model.id === defaultModel)) options.unshift({ id: defaultModel, label: defaultModel });
  return { default: defaultModel, options };
}

function safeHttpError(status: number): Error {
  if (status === 401 || status === 403) return new Error(`provider authentication failed (HTTP ${status})`);
  if (status === 429) return new Error("provider rate limited the request (HTTP 429)");
  return new Error(`provider request failed (HTTP ${status})`);
}

export const OpenAICompatibleDriver: ProviderDriver<OpenAICompatibleConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "OpenAI-compatible API", supportsMultipleInstances: true },
  models: { default: "", options: [] },
  decodeConfig,
  defaultConfig: () => decodeConfig({ baseUrl: "http://127.0.0.1:1234/v1", requiresApiKey: false }),

  async create(input: DriverCreateInput<OpenAICompatibleConfig>): Promise<ProviderInstance> {
    const { config } = input;
    const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
    const models = catalog(config);
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();
    const emit = (event: RuntimeEvent) => listeners.forEach((listener) => listener(event));
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(), provider: DRIVER_KIND, threadId, turnId, createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      if (config.requiresApiKey && !apiKey) throw new Error("no API key configured for this provider");
      if (!turn.model) throw new Error("select a discovered model or enter a model ID before sending a message");
      if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const abort = new AbortController();
      active.set(turn.threadId, { abort, turnId });
      emit({ ...base(turn.threadId, turnId), type: "turn.started" });
      emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId: null, model: turn.model });
      void (async () => {
        try {
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (apiKey) headers.authorization = `Bearer ${apiKey}`;
          const response = await fetch(`${config.baseUrl}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: turn.model,
              messages: [
                ...(turn.system ? [{ role: "system", content: turn.system }] : []),
                ...(turn.transcript ?? []).map((message) => ({ role: message.role, content: message.text })),
                { role: "user", content: turn.text },
              ],
              stream: true,
            }),
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(TURN_TIMEOUT_MS)]),
          });
          if (!response.ok) throw safeHttpError(response.status);
          if (!response.body) throw new Error("provider returned an empty streaming response");
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let text = "";
          const streamState: { usage: { input: number; output: number } | null } = { usage: null };
          const consume = (line: string) => {
            if (!line.startsWith("data:")) return;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") return;
            try {
              const chunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta) {
                text += delta;
                emit({ ...base(turn.threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
              }
              if (chunk.usage) {
                streamState.usage = {
                  input: Number(chunk.usage.prompt_tokens) || 0,
                  output: Number(chunk.usage.completion_tokens) || 0,
                };
              }
            } catch {
              // A malformed SSE event is not evidence of a failed turn; retain valid events around it.
            }
          };
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              consume(buffer.slice(0, newline).trim());
              buffer = buffer.slice(newline + 1);
            }
          }
          buffer += decoder.decode();
          if (buffer.trim()) consume(buffer.trim());
          if (text.trim()) emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
          const reportedUsage = streamState.usage;
          if (reportedUsage) {
            emit({
              ...base(turn.threadId, turnId),
              type: "thread.token-usage.updated",
              input: reportedUsage.input,
              output: reportedUsage.output,
            });
          }
          emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
        } catch (error) {
          const interrupted = abort.signal.aborted || (error instanceof Error && error.name === "AbortError");
          if (!interrupted) emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: error instanceof Error ? error.message : "provider request failed" });
          emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: false, stopReason: interrupted ? "interrupted" : "error", cost: null });
        } finally {
          active.delete(turn.threadId);
        }
      })();
      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (config.requiresApiKey && !apiKey) return { state: "unavailable", reason: "no API key configured" };
      if (!models.default) return { state: "unavailable", reason: "no models discovered — refresh models or enter a model ID" };
      return { state: "available", authenticated: Boolean(apiKey), version: "Chat only" };
    };

    return {
      instanceId: input.instanceId, driverKind: DRIVER_KIND, displayName: input.displayName, enabled: input.enabled, models, snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "unsupported" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        respondToRequest: async () => { throw new Error("this API provider has no pending approvals"); },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => { active.forEach(({ abort }) => abort.abort()); },
        onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      },
      dispose: async () => { active.forEach(({ abort }) => abort.abort()); listeners.clear(); },
    };
  },
};
