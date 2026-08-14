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
import { appendNative } from "./native.ts";

export interface OpenAIEndpointConfig {
  url: string;
  model: string;
  apiKeyEnv: string;
}

interface EndpointDriverSpec {
  driverKind: string;
  displayName: string;
  defaultUrl: string;
  defaultModel: string;
  apiKeyEnv: string;
  credentialRequired: boolean;
  headers?: Record<string, string>;
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("url must be an absolute HTTP or HTTPS URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) throw new Error("url must not contain embedded credentials");
  if (parsed.search || parsed.hash) throw new Error("url must not contain a query string or fragment");
  return parsed.href.replace(/\/+$/, "");
}

function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function errorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const error = (value as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return null;
}

function abortSignal(signal?: AbortSignal, timeoutMs = 120_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readResponseBytes(response: Response, limitBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limitBytes) throw new Error(`provider response exceeded the ${limitBytes} byte response limit`);
      chunks.push(value);
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function readJson(response: Response, limitBytes = 4 * 1024 * 1024): Promise<any> {
  const bytes = await readResponseBytes(response, limitBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("provider returned invalid JSON");
  }
}

async function boundedError(response: Response): Promise<string> {
  return new TextDecoder().decode(await readResponseBytes(response, 1024 * 1024)).slice(0, 200);
}

export function createOpenAIEndpointDriver(spec: EndpointDriverSpec): ProviderDriver<OpenAIEndpointConfig> {
  const decodeConfig = (raw: unknown): OpenAIEndpointConfig => {
    const value = (raw ?? {}) as Record<string, unknown>;
    return {
      url: normalizeBaseUrl(typeof value.url === "string" && value.url.trim() ? value.url.trim() : spec.defaultUrl),
      model: typeof value.model === "string" && value.model.trim() ? value.model.trim() : spec.defaultModel,
      apiKeyEnv: spec.apiKeyEnv,
    };
  };
  const declaredModels: ModelCatalog = {
    default: spec.defaultModel,
    options: [{ id: spec.defaultModel, label: spec.defaultModel }],
  };

  return {
    driverKind: spec.driverKind,
    metadata: { displayName: spec.displayName, supportsMultipleInstances: true },
    models: declaredModels,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),

    async create(input: DriverCreateInput<OpenAIEndpointConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      const apiKey = input.environment[config.apiKeyEnv] ?? "";
      const listeners = new Set<RuntimeEventListener>();
      const active = new Map<string, { abort: AbortController; turnId: string }>();
      const models: ModelCatalog = {
        default: config.model,
        options: [{ id: config.model, label: config.model }],
      };

      const emit = (event: RuntimeEvent) => {
        for (const listener of [...listeners]) listener(event);
      };
      const base = (threadId: string, turnId: string) => ({
        eventId: newEventId(),
        provider: spec.driverKind,
        providerInstanceId: instanceId,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });
      const headers = (json = false): Record<string, string> => ({
        accept: "application/json",
        ...(json ? { "content-type": "application/json" } : {}),
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...spec.headers,
      });
      const requireCredential = () => {
        if (spec.credentialRequired && !apiKey) {
          throw new Error(`${spec.displayName} needs ${config.apiKeyEnv}`);
        }
      };

      const discoverModels = async () => {
        requireCredential();
        const response = await fetch(endpointUrl(config.url, "/models"), {
          method: "GET",
          headers: headers(),
          signal: abortSignal(undefined, 15_000),
        });
        if (!response.ok) {
          const body = await boundedError(response);
          throw new Error(`${spec.displayName} models HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
        }
        const payload = (await readJson(response)) as Record<string, unknown>;
        const rawModels = Array.isArray(payload.data)
          ? payload.data
          : Array.isArray(payload.models)
            ? payload.models
            : [];
        const discovered = rawModels.flatMap((entry): Array<{ id: string; label: string }> => {
          if (typeof entry === "string") return [{ id: entry, label: entry }];
          if (!entry || typeof entry !== "object") return [];
          const record = entry as Record<string, unknown>;
          const id = typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : "";
          return id ? [{ id, label: id }] : [];
        });
        const unique = [...new Map(discovered.map((entry) => [entry.id, entry])).values()];
        models.options = unique.some((entry) => entry.id === config.model)
          ? unique
          : [{ id: config.model, label: config.model }, ...unique];
      };

      const complete = async (
        messages: ChatMessage[],
        model: string,
        options: { stream: boolean; signal?: AbortSignal; onDelta?: (delta: string) => void },
      ): Promise<{ text: string; usage: { input: number; output: number } | null }> => {
        const response = await fetch(endpointUrl(config.url, "/chat/completions"), {
          method: "POST",
          headers: headers(true),
          body: JSON.stringify({ model, messages, stream: options.stream }),
          signal: abortSignal(options.signal),
        });
        if (!response.ok) {
          const body = await boundedError(response);
          throw new Error(`${spec.displayName} HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
        }
        if (!options.stream) {
          const payload = (await readJson(response)) as any;
          const apiError = errorMessage(payload);
          if (apiError) throw new Error(`${spec.displayName}: ${apiError}`);
          return {
            text: String(payload.choices?.[0]?.message?.content ?? ""),
            usage: payload.usage
              ? {
                  input: Number(payload.usage.prompt_tokens ?? 0),
                  output: Number(payload.usage.completion_tokens ?? 0),
                }
              : null,
          };
        }
        if (!response.body) throw new Error(`${spec.displayName} returned an empty stream`);

        let text = "";
        let usage: { input: number; output: number } | null = null;
        const parseLine = (rawLine: string) => {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) return;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") return;
          const payload = JSON.parse(data) as any;
          const apiError = errorMessage(payload);
          if (apiError) throw new Error(`${spec.displayName}: ${apiError}`);
          const delta = payload.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            text += delta;
            options.onDelta?.(delta);
          }
          if (payload.usage) {
            usage = {
              input: Number(payload.usage.prompt_tokens ?? 0),
              output: Number(payload.usage.completion_tokens ?? 0),
            };
          }
        };

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let received = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > 32 * 1024 * 1024) throw new Error("provider stream exceeded the response limit");
            buffer += decoder.decode(value, { stream: true });
            let newline = buffer.indexOf("\n");
            while (newline !== -1) {
              parseLine(buffer.slice(0, newline));
              buffer = buffer.slice(newline + 1);
              newline = buffer.indexOf("\n");
            }
          }
          buffer += decoder.decode();
          if (buffer.trim()) parseLine(buffer);
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw error;
        } finally {
          reader.releaseLock();
        }
        return { text, usage };
      };

      const sendTurn = async (turn: SendTurnInput) => {
        requireCredential();
        if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");
        const turnId = newId();
        const abort = new AbortController();
        active.set(turn.threadId, { abort, turnId });
        const model = turn.model || models.default;
        const messages: ChatMessage[] = [
          ...(turn.system ? [{ role: "system" as const, content: turn.system }] : []),
          ...(turn.transcript ?? []).map((message) => ({
            role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
            content: message.text,
          })),
          { role: "user", content: turn.text },
        ];
        appendNative(turn.threadId, {
          dir: "out",
          source: `${spec.driverKind}.chat.completions`,
          msg: { model, messages },
        });
        emit({ ...base(turn.threadId, turnId), type: "turn.started" });
        emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId: null, model });

        void (async () => {
          try {
            const result = await complete(messages, model, {
              stream: true,
              signal: abort.signal,
              onDelta: (delta) =>
                emit({
                  ...base(turn.threadId, turnId),
                  type: "content.delta",
                  streamKind: "assistant_text",
                  delta,
                }),
            });
            appendNative(turn.threadId, {
              dir: "in",
              source: `${spec.driverKind}.chat.completions`,
              msg: result,
            });
            if (result.text.trim()) {
              emit({
                ...base(turn.threadId, turnId),
                type: "item.completed",
                itemType: "assistant_text",
                text: result.text,
              });
            }
            if (result.usage) {
              emit({
                ...base(turn.threadId, turnId),
                type: "thread.token-usage.updated",
                input: result.usage.input,
                output: result.usage.output,
              });
            }
            active.delete(turn.threadId);
            emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
          } catch (error) {
            active.delete(turn.threadId);
            const aborted = abort.signal.aborted || (error as Error).name === "AbortError";
            if (!aborted) {
              emit({
                ...base(turn.threadId, turnId),
                type: "runtime.error",
                message: error instanceof Error ? error.message : String(error),
              });
            }
            emit({
              ...base(turn.threadId, turnId),
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
        if (!input.enabled) return { state: "unavailable", reason: `${spec.displayName} is disabled` };
        if (spec.credentialRequired && !apiKey) {
          return { state: "unavailable", reason: `${spec.displayName} needs ${config.apiKeyEnv}` };
        }
        try {
          await discoverModels();
          return { state: "available", authenticated: true, version: null };
        } catch (error) {
          return {
            state: "unavailable",
            authenticated: Boolean(apiKey) || !spec.credentialRequired,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      };

      return {
        instanceId,
        driverKind: spec.driverKind,
        displayName: input.displayName,
        enabled: input.enabled,
        models,
        snapshot,
        adapter: {
          provider: spec.driverKind,
          capabilities: { sessionModelSwitch: "in-session" },
          sendTurn,
          interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
          respondToRequest: async () => {
            throw new Error(`${spec.displayName} has no pending requests`);
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
        generateText: async (prompt) => {
          requireCredential();
          const result = await complete([{ role: "user", content: prompt }], models.default, {
            stream: false,
          });
          return result.text;
        },
        dispose: async () => {
          for (const { abort } of active.values()) abort.abort();
          active.clear();
          listeners.clear();
        },
      };
    },
  };
}

export const OpenAICompatibleDriver = createOpenAIEndpointDriver({
  driverKind: "openaiCompatible",
  displayName: "OpenAI-compatible",
  defaultUrl: "http://127.0.0.1:11434/v1",
  defaultModel: "llama3.2",
  apiKeyEnv: "OPENAI_COMPATIBLE_API_KEY",
  credentialRequired: false,
});
