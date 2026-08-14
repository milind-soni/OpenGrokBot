import type {
  DriverCreateInput,
  GeneratedMedia,
  GenerateMediaInput,
  ModelCatalog,
  ModelTask,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { mediaPromptOptions } from "../media-intent.ts";
import { appendNative } from "./native.ts";

export interface OpenAIEndpointConfig {
  url: string;
  model: string;
  apiKeyEnv: string;
  modelTasks: Record<string, ModelTask>;
  imagePath: string;
  videoPath: string;
}

interface EndpointDriverSpec {
  driverKind: string;
  displayName: string;
  defaultUrl: string;
  defaultModel: string;
  apiKeyEnv: string;
  credentialRequired: boolean;
  headers?: Record<string, string>;
  imageModelsPath?: string;
  videoModelsPath?: string;
  imagePath?: string;
  videoPath?: string;
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

export function normalizeEndpointPath(value: unknown, fallback: string): string {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (!candidate.startsWith("/") || candidate.startsWith("//")) {
    throw new Error("endpoint path must be a same-origin absolute path");
  }
  if (candidate.includes("?") || candidate.includes("#")) {
    throw new Error("endpoint path must not contain a query string or fragment");
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("endpoint path must not contain relative segments");
  }
  return `/${segments.filter(Boolean).join("/")}`;
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

async function readJson(response: Response, limitBytes = 2 * 1024 * 1024): Promise<any> {
  const bytes = await readResponseBytes(response, limitBytes);
  if (!bytes.byteLength) return {};
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("provider returned invalid JSON");
  }
}

async function requireOk(response: Response, displayName: string): Promise<void> {
  if (response.ok) return;
  const bytes = await readResponseBytes(response, 1024 * 1024);
  const body = new TextDecoder().decode(bytes).slice(0, 200);
  throw new Error(`${displayName} HTTP ${response.status}${body ? `: ${body}` : ""}`);
}

function discoveredTask(entry: Record<string, unknown>): ModelTask | undefined {
  const output = Array.isArray(entry.output_modalities)
    ? entry.output_modalities
    : entry.architecture && typeof entry.architecture === "object" &&
        Array.isArray((entry.architecture as Record<string, unknown>).output_modalities)
      ? ((entry.architecture as Record<string, unknown>).output_modalities as unknown[])
      : [];
  if (output.some((item) => item === "video")) return "video";
  if (output.some((item) => item === "image")) return "image";
  return undefined;
}

export function createOpenAIEndpointDriver(spec: EndpointDriverSpec): ProviderDriver<OpenAIEndpointConfig> {
  const decodeConfig = (raw: unknown): OpenAIEndpointConfig => {
    const value = (raw ?? {}) as Record<string, unknown>;
    return {
      url: normalizeBaseUrl(typeof value.url === "string" && value.url.trim() ? value.url.trim() : spec.defaultUrl),
      model: typeof value.model === "string" && value.model.trim() ? value.model.trim() : spec.defaultModel,
      apiKeyEnv: spec.apiKeyEnv,
      modelTasks: value.modelTasks && typeof value.modelTasks === "object"
        ? Object.fromEntries(
            Object.entries(value.modelTasks as Record<string, unknown>).filter(
              (entry): entry is [string, ModelTask] =>
                Boolean(entry[0].trim()) && (entry[1] === "chat" || entry[1] === "image" || entry[1] === "video"),
            ),
          )
        : {},
      imagePath: normalizeEndpointPath(value.imagePath, spec.imagePath ?? "/images/generations"),
      videoPath: normalizeEndpointPath(value.videoPath, spec.videoPath ?? "/videos"),
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

      const parseModels = (payload: Record<string, unknown>, forcedTask?: ModelTask) => {
        const rawModels = Array.isArray(payload.data)
          ? payload.data
          : Array.isArray(payload.models)
            ? payload.models
            : [];
        return rawModels.flatMap((entry): ModelCatalog["options"] => {
          if (typeof entry === "string") {
            const task = config.modelTasks[entry] ?? forcedTask;
            return [{ id: entry, label: entry, ...(task ? { task } : {}) }];
          }
          if (!entry || typeof entry !== "object") return [];
          const record = entry as Record<string, unknown>;
          const id = typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : "";
          if (!id) return [];
          const task = config.modelTasks[id] ?? forcedTask ?? discoveredTask(record);
          const architecture = record.architecture && typeof record.architecture === "object"
            ? record.architecture as Record<string, unknown>
            : {};
          const inputModalities = Array.isArray(record.input_modalities)
            ? record.input_modalities.filter((item): item is string => typeof item === "string")
            : Array.isArray(architecture.input_modalities)
              ? architecture.input_modalities.filter((item): item is string => typeof item === "string")
              : undefined;
          const outputModalities = Array.isArray(record.output_modalities)
            ? record.output_modalities.filter((item): item is string => typeof item === "string")
            : Array.isArray(architecture.output_modalities)
              ? architecture.output_modalities.filter((item): item is string => typeof item === "string")
              : undefined;
          return [{ id, label: id, ...(task ? { task } : {}), ...(inputModalities ? { inputModalities } : {}), ...(outputModalities ? { outputModalities } : {}) }];
        });
      };

      const fetchModelCatalog = async (path: string, forcedTask?: ModelTask) => {
        const response = await fetch(endpointUrl(config.url, path), {
          method: "GET",
          headers: headers(),
          signal: abortSignal(undefined, 15_000),
        });
        await requireOk(response, `${spec.displayName} models`);
        return parseModels(await readJson(response), forcedTask);
      };

      const discoverModels = async () => {
        requireCredential();
        const discovered = await fetchModelCatalog("/models");
        if (spec.imageModelsPath) {
          try { discovered.push(...await fetchModelCatalog(spec.imageModelsPath, "image")); } catch {}
        }
        if (spec.videoModelsPath) {
          try { discovered.push(...await fetchModelCatalog(spec.videoModelsPath, "video")); } catch {}
        }
        for (const [id, task] of Object.entries(config.modelTasks)) {
          discovered.push({ id, label: id, task });
        }
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
        await requireOk(response, spec.displayName);
        if (!options.stream) {
          const payload = (await readJson(response, 4 * 1024 * 1024)) as any;
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

      const generateImage = async (request: GenerateMediaInput): Promise<GeneratedMedia[]> => {
        const options = mediaPromptOptions(request.prompt);
        const response = await fetch(endpointUrl(config.url, config.imagePath), {
          method: "POST",
          headers: headers(true),
          body: JSON.stringify({
            model: request.model,
            prompt: request.prompt,
            response_format: "b64_json",
            ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
          }),
          signal: abortSignal(request.signal, 3 * 60_000),
        });
        await requireOk(response, spec.displayName);
        const payload = await readJson(response, 40 * 1024 * 1024) as Record<string, unknown>;
        const apiError = errorMessage(payload);
        if (apiError) throw new Error(`${spec.displayName}: ${apiError}`);
        const data = Array.isArray(payload.data) ? payload.data : [];
        const generated = data.flatMap((entry): GeneratedMedia[] => {
          if (!entry || typeof entry !== "object") return [];
          const record = entry as Record<string, unknown>;
          const base64 = typeof record.b64_json === "string" ? record.b64_json : "";
          if (!base64) return [];
          const mime = typeof record.mime_type === "string" ? record.mime_type : "image/png";
          return [{ kind: "image", source: { type: "base64", data: base64, mime }, mime }];
        });
        if (!generated.length) {
          throw new Error(`${spec.displayName} did not return embedded image data`);
        }
        return generated;
      };

      const abortablePause = (milliseconds: number, signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          const timer = setTimeout(resolve, milliseconds);
          timer.unref?.();
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
          }, { once: true });
        });

      const generateVideo = async (request: GenerateMediaInput): Promise<GeneratedMedia[]> => {
        const options = mediaPromptOptions(request.prompt);
        const submit = await fetch(endpointUrl(config.url, config.videoPath), {
          method: "POST",
          headers: headers(true),
          body: JSON.stringify({
            model: request.model,
            prompt: request.prompt,
            ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
            ...(options.durationSeconds ? { duration: options.durationSeconds } : {}),
          }),
          signal: abortSignal(request.signal, 60_000),
        });
        await requireOk(submit, spec.displayName);
        const submitted = await readJson(submit) as Record<string, unknown>;
        const jobId = typeof submitted.id === "string"
          ? submitted.id
          : typeof submitted.job_id === "string"
            ? submitted.job_id
            : "";
        if (!jobId) throw new Error(`${spec.displayName} did not return a video job id`);
        request.onProgress?.({ providerJobId: jobId });
        const statusPath = `${config.videoPath}/${encodeURIComponent(jobId)}`;
        const interval = Math.max(0, request.pollIntervalMs ?? 2_000);

        for (;;) {
          if (interval) await abortablePause(interval, request.signal);
          const statusResponse = await fetch(endpointUrl(config.url, statusPath), {
            method: "GET",
            headers: headers(),
            signal: abortSignal(request.signal, 30_000),
          });
          await requireOk(statusResponse, spec.displayName);
          const statusPayload = await readJson(statusResponse) as Record<string, unknown>;
          const status = String(statusPayload.status ?? "").toLowerCase();
          const progress = Number(statusPayload.progress);
          request.onProgress?.({
            providerJobId: jobId,
            ...(Number.isFinite(progress) ? { progress: Math.max(0, Math.min(1, progress > 1 ? progress / 100 : progress)) } : {}),
          });
          if (["failed", "error", "cancelled", "canceled"].includes(status)) {
            throw new Error(`${spec.displayName} video generation ${status}`);
          }
          if (["completed", "complete", "succeeded", "ready"].includes(status)) break;
        }

        const content = await fetch(endpointUrl(config.url, `${statusPath}/content?index=0`), {
          method: "GET",
          headers: headers(),
          signal: abortSignal(request.signal, 3 * 60_000),
        });
        await requireOk(content, spec.displayName);
        const mime = content.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "video/mp4";
        const bytes = await readResponseBytes(content, 512 * 1024 * 1024);
        if (!bytes.byteLength) throw new Error(`${spec.displayName} returned an empty video`);
        return [{
          kind: "video",
          source: { type: "bytes", data: bytes, mime },
          mime,
          providerJobId: jobId,
          ...(options.durationSeconds ? { durationSeconds: options.durationSeconds } : {}),
        }];
      };

      const generateMedia = async (request: GenerateMediaInput): Promise<GeneratedMedia[]> => {
        requireCredential();
        request.signal.throwIfAborted();
        return request.task === "image" ? generateImage(request) : generateVideo(request);
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
        generateMedia,
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
