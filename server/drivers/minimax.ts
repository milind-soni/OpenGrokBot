// MiniMax driver — OpenAI-compatible chat/completions API with SSE streaming.
// Reads config from ~/.minimax/user-settings.json (populated by MiniMax Code)
// or from MINIMAX_API_KEY env / openmausbot config.json.
//
// API: https://api.minimax.io/v1/chat/completions
// Models: MiniMax-M3 (frontier coding/agentic, 1M ctx), minimax-01, minimax-pro
//
// To register: add to server/drivers/builtIn.ts imports + BUILT_IN_DRIVERS array.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "minimax";
const DEFAULT_URL = "https://api.minimax.io/v1";

const MODELS = {
  default: "MiniMax-M3",
  options: [
    { id: "MiniMax-M3",          label: "MiniMax M3 (Frontier · 1M ctx)" },
    { id: "minimax-01",          label: "MiniMax 01" },
    { id: "minimax-pro",         label: "MiniMax Pro" },
    { id: "minimax-pro-128k",    label: "MiniMax Pro 128k" },
    { id: "minimax-pro-voice",   label: "MiniMax Pro Voice" },
    { id: "minimax-vision",      label: "MiniMax Vision" },
  ],
};

export interface MinimaxConfig {
  url: string;
  /** env-var name holding the API key, default MINIMAX_API_KEY */
  apiKeyEnv: string;
}

function loadLocalKey(): string {
  try {
    const p = join(homedir(), ".minimax", "user-settings.json");
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return (raw.apiKey as string) ?? "";
  } catch {
    return "";
  }
}

function decodeConfig(raw: unknown): MinimaxConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    url: typeof o.url === "string" ? o.url : DEFAULT_URL,
    apiKeyEnv: typeof o.apiKeyEnv === "string" ? o.apiKeyEnv : "MINIMAX_API_KEY",
  };
}

export const MinimaxDriver: ProviderDriver<MinimaxConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "MiniMax (API)", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<MinimaxConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;

    // Resolution order: instance env → process env → ~/.minimax/user-settings.json
    const apiKey =
      input.environment[config.apiKeyEnv] ??
      process.env[config.apiKeyEnv] ??
      loadLocalKey();

    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();

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

    const complete = async (
      messages: Array<{ role: string; content: string }>,
      model: string,
      opts: { stream: boolean; signal?: AbortSignal; onDelta?: (d: string) => void },
    ): Promise<{ text: string; usage: { input: number; output: number } | null }> => {
      const res = await fetch(`${config.url}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages, stream: opts.stream }),
        signal: opts.signal ?? AbortSignal.timeout(180_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`MiniMax HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
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

      // SSE streaming — identical to grok.ts pattern
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
          try { chunk = JSON.parse(data); } catch { continue; }
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) { text += delta; opts.onDelta?.(delta); }
          if (chunk.usage) {
            usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
          }
        }
      }
      return { text, usage };
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (!apiKey) throw new Error(`no MiniMax key — set MINIMAX_API_KEY or add to ~/.minimax/user-settings.json`);
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

      appendNative(threadId, { dir: "out", source: "minimax.chat.completions", msg: { model: turn.model, messages } });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model: turn.model ?? MODELS.default });

      (async () => {
        try {
          const { text, usage } = await complete(messages, turn.model || MODELS.default, {
            stream: true,
            signal: abort.signal,
            onDelta: (delta) =>
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta }),
          });

          appendNative(threadId, { dir: "in", source: "minimax.chat.completions", msg: { text, usage } });

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
      if (!apiKey) {
        return {
          state: "unavailable",
          reason: `no MiniMax API key — add to ~/.minimax/user-settings.json or set MINIMAX_API_KEY`,
        };
      }
      // Quick connectivity check — cheap models list call
      try {
        const res = await fetch(`${config.url}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return { state: "unavailable", reason: `MiniMax API returned ${res.status}` };
      } catch {
        return { state: "unavailable", reason: "MiniMax API unreachable" };
      }
      return { state: "available", authenticated: true, version: null };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        respondToRequest: async () => { throw new Error("minimax driver has no pending asks"); },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => { for (const { abort } of active.values()) abort.abort(); },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt: string) => {
        const { text } = await complete([{ role: "user", content: prompt }], "minimax-01", { stream: false });
        return text;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};
