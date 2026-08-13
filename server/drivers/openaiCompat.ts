// OpenAI-compatible chat driver family — one implementation, three faces:
//   ollama      → http://127.0.0.1:11434/v1  (local, no key)
//   lmstudio    → http://127.0.0.1:1234/v1   (local, no key)
//   openaiCompat→ any /v1 endpoint the user configures (OpenAI, OpenRouter,
//                 Groq, Together, vLLM, llama.cpp server, …)
// Transcript-replay like the grok driver: the harness hands the folded
// thread history each turn; we stream true token deltas from
// POST {base}/chat/completions. Models are DISCOVERED live from
// GET {base}/models (Ollama and LM Studio both serve it), so whatever
// the user has pulled/loaded locally shows up in the picker by itself.
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

export interface OpenAICompatConfig {
  /** Base URL up to and including /v1 (no trailing slash). */
  baseUrl: string;
  /** Env var the API key is read from (empty ⇒ no key required). */
  apiKeyEnv: string;
  /** Static model list — used when discovery fails or is disabled. */
  models: string[];
  defaultModel: string;
  /** Ask {base}/models for the live list (on by default). */
  discoverModels: boolean;
}

interface Flavor {
  driverKind: string;
  displayName: string;
  defaults: Partial<OpenAICompatConfig>;
  /** Human hint shown when the endpoint is unreachable. */
  offlineHint: string;
  /** Require a key before reporting available (custom endpoints only). */
  needsConfig?: boolean;
}

const label = (id: string) =>
  id
    .replace(/^[^/]*\//, "") // strip org prefixes like "meta-llama/"
    .replace(/[:_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());

export function decodeOpenAICompatConfig(raw: unknown, defaults: Partial<OpenAICompatConfig> = {}): OpenAICompatConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const baseUrl = (typeof o.baseUrl === "string" && o.baseUrl.trim() ? o.baseUrl : (defaults.baseUrl ?? ""))
    .trim()
    .replace(/\/+$/, "");
  const models = Array.isArray(o.models)
    ? o.models.map(String).filter(Boolean)
    : (defaults.models ?? []);
  return {
    baseUrl,
    apiKeyEnv: typeof o.apiKeyEnv === "string" ? o.apiKeyEnv : (defaults.apiKeyEnv ?? ""),
    models,
    defaultModel:
      typeof o.defaultModel === "string" && o.defaultModel ? o.defaultModel : (defaults.defaultModel ?? models[0] ?? ""),
    discoverModels: typeof o.discoverModels === "boolean" ? o.discoverModels : (defaults.discoverModels ?? true),
  };
}

function makeDriver(flavor: Flavor): ProviderDriver<OpenAICompatConfig> {
  const FALLBACK: ModelCatalog = {
    default: flavor.defaults.defaultModel ?? flavor.defaults.models?.[0] ?? "",
    options: (flavor.defaults.models ?? []).map((id) => ({ id, label: label(id) })),
  };

  return {
    driverKind: flavor.driverKind,
    metadata: { displayName: flavor.displayName, supportsMultipleInstances: true },
    models: FALLBACK,
    decodeConfig: (raw) => decodeOpenAICompatConfig(raw, flavor.defaults),
    defaultConfig: () => decodeOpenAICompatConfig({}, flavor.defaults),

    async create(input: DriverCreateInput<OpenAICompatConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      const apiKey = config.apiKeyEnv
        ? (input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "")
        : "";
      const listeners = new Set<RuntimeEventListener>();
      const active = new Map<string, { abort: AbortController; turnId: string }>();

      const emit = (event: RuntimeEvent) => {
        for (const l of [...listeners]) l(event);
      };
      const base = (threadId: string, turnId: string) => ({
        eventId: newEventId(),
        provider: flavor.driverKind,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });
      const headers = () => ({
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      });

      // ── live model discovery, cached briefly so describe() stays cheap ──
      // The catalog object is MUTATED in place: the registry hands out a
      // reference to instance.models once, so replacing the array contents
      // (not the object) is what makes newly pulled models appear.
      const catalog: ModelCatalog = {
        default: config.defaultModel || FALLBACK.default,
        options: config.models.length ? config.models.map((id) => ({ id, label: label(id) })) : [...FALLBACK.options],
      };
      let lastProbe = 0;
      let lastProbeOk: boolean | null = null;
      let probeError = "";
      const PROBE_TTL = 5_000;

      const refreshModels = async (): Promise<boolean> => {
        if (!config.baseUrl) return false;
        if (Date.now() - lastProbe < PROBE_TTL && lastProbeOk !== null) return lastProbeOk;
        lastProbe = Date.now();
        try {
          const res = await fetch(`${config.baseUrl}/models`, {
            headers: headers(),
            signal: AbortSignal.timeout(2_500),
          });
          if (!res.ok) {
            probeError = `HTTP ${res.status} from ${config.baseUrl}/models`;
            lastProbeOk = res.status < 500 && res.status !== 404; // auth errors still prove it's alive
            return lastProbeOk;
          }
          const json: any = await res.json();
          const ids: string[] = (Array.isArray(json.data) ? json.data : [])
            .map((m: any) => String(m?.id ?? ""))
            .filter(Boolean);
          if (config.discoverModels && ids.length) {
            catalog.options.splice(
              0,
              catalog.options.length,
              ...ids.map((id) => ({ id, label: label(id) })),
            );
            if (!ids.includes(catalog.default)) catalog.default = ids[0];
          }
          lastProbeOk = true;
          probeError = "";
          return true;
        } catch (e) {
          probeError = e instanceof Error ? e.message : String(e);
          lastProbeOk = false;
          return false;
        }
      };
      // warm the catalog in the background; never block create()
      void refreshModels();

      const complete = async (
        messages: Array<{ role: string; content: string }>,
        model: string,
        opts: { stream: boolean; signal?: AbortSignal; onDelta?: (d: string) => void },
      ): Promise<{ text: string; usage: { input: number; output: number } | null }> => {
        const res = await fetch(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ model, messages, stream: opts.stream }),
          signal: opts.signal ?? AbortSignal.timeout(300_000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`${flavor.displayName} HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
        }
        if (!opts.stream) {
          const json: any = await res.json();
          return {
            text: json.choices?.[0]?.message?.content ?? "",
            usage: json.usage
              ? { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 }
              : null,
          };
        }
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
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            let chunk: any;
            try {
              chunk = JSON.parse(data);
            } catch {
              continue;
            }
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              text += delta;
              opts.onDelta?.(delta);
            }
            if (chunk.usage) {
              usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
            }
          }
        }
        return { text, usage };
      };

      const sendTurn = async (turn: SendTurnInput) => {
        const { threadId } = turn;
        if (!config.baseUrl) throw new Error(`${flavor.displayName} has no base URL — configure it in App Settings`);
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        const turnId = newId();
        const abort = new AbortController();
        active.set(threadId, { abort, turnId });

        const messages = [
          ...(turn.system ? [{ role: "system", content: turn.system }] : []),
          ...(turn.transcript ?? []).map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.text,
          })),
          { role: "user", content: turn.text },
        ];
        const source = `${flavor.driverKind}.chat.completions`;
        appendNative(threadId, { dir: "out", source, msg: { model: turn.model, messages } });

        emit({ ...base(threadId, turnId), type: "turn.started" });
        emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model: turn.model ?? catalog.default });

        (async () => {
          try {
            const { text, usage } = await complete(messages, turn.model || catalog.default, {
              stream: true,
              signal: abort.signal,
              onDelta: (delta) =>
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta }),
            });
            appendNative(threadId, { dir: "in", source, msg: { text, usage } });
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
        if (!config.baseUrl) {
          return {
            state: "unavailable",
            reason:
              flavor.driverKind === "openaiCompat"
                ? "not configured — add a base URL (and key) in App Settings"
                : `${flavor.displayName} base URL missing`,
          };
        }
        if (flavor.needsConfig && !apiKey && /api\.openai\.com|openrouter\.ai|api\.groq\.com/.test(config.baseUrl)) {
          return { state: "unavailable", reason: `this endpoint needs an API key — add it in App Settings` };
        }
        const ok = await refreshModels();
        if (!ok) {
          return { state: "unavailable", reason: `${flavor.offlineHint} (${probeError || "unreachable"})` };
        }
        return {
          state: "available",
          authenticated: true,
          version: `${catalog.options.length} model${catalog.options.length === 1 ? "" : "s"} @ ${config.baseUrl.replace(/^https?:\/\//, "")}`,
        };
      };

      return {
        instanceId,
        driverKind: flavor.driverKind,
        displayName: input.displayName,
        enabled: input.enabled,
        models: catalog,
        snapshot,
        adapter: {
          provider: flavor.driverKind,
          capabilities: { sessionModelSwitch: "in-session" },
          sendTurn,
          interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
          respondToRequest: async () => {
            throw new Error(`${flavor.displayName} driver has no pending asks`);
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
          const { text } = await complete([{ role: "user", content: prompt }], catalog.default, { stream: false });
          return text;
        },
        dispose: async () => {
          for (const { abort } of active.values()) abort.abort();
          listeners.clear();
        },
      };
    },
  };
}

export const OllamaDriver = makeDriver({
  driverKind: "ollama",
  displayName: "Ollama",
  defaults: {
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKeyEnv: "",
    models: [],
    discoverModels: true,
  },
  offlineHint: "Ollama isn't running — start it with `ollama serve` (models appear automatically)",
});

export const LMStudioDriver = makeDriver({
  driverKind: "lmstudio",
  displayName: "LM Studio",
  defaults: {
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKeyEnv: "",
    models: [],
    discoverModels: true,
  },
  offlineHint: "LM Studio's server is off — enable it in LM Studio → Developer → Start Server",
});

export const OpenAICompatDriver = makeDriver({
  driverKind: "openaiCompat",
  displayName: "OpenAI-compatible",
  defaults: {
    baseUrl: "",
    apiKeyEnv: "OPENAI_COMPAT_API_KEY",
    models: [],
    discoverModels: true,
  },
  offlineHint: "endpoint unreachable — check the base URL in App Settings",
  needsConfig: true,
});
