// hermes-os driver — wraps Tony's Agent OS hub (`tonysplace_best/backend/agent-os`,
// FastAPI on :8001) as an OpenMausBot ProviderDriver.
//
// The hub exposes an OpenAI-compatible surface at /v1/models and
// /v1/chat/completions, including SSE streaming when stream=true. We map
// a single ProviderInstance to one (baseUrl, default model) pair; the
// model catalog is a static copy of the hub's known provider set so the
// model picker has something to render before the hub is reachable.
//
// Auth: the hub accepts requests with no Authorization header when
// HUB_API_TOKEN is unset (the dev/homelab default). When it is set, the
// caller must send `Authorization: Bearer <HUB_API_TOKEN>`. The driver
// reads the token from the instance config (apiKey) or HUB_API_TOKEN env.
//
// Streaming: hermes-os emits chunks of the form `data: {"choices":[{"delta":{"content":"..."}}]}\n\n`
// and terminates with `data: [DONE]\n\n`. We map each delta to a
// `content.delta` RuntimeEvent with streamKind="assistant_text", and emit
// a final `item.completed: assistant_text` event with the concatenated
// text plus `turn.completed` (and a `thread.token-usage.updated` when
// usage is present in the final non-delta chunk).
//
// Integrations: hermes-os has its own integrations story (Composio via
// config, Antigravity SDK, etc.). We surface it as a passthrough: when
// SendTurnInput.integrations is set, the driver logs it and continues;
// the hub's own model handles tool wiring from its side. Computer-use
// and agent peer-comms are not supported by the hub yet, so we no-op
// them with a single event.note (the driver never silently swallows).

import { appendNative } from "./native.ts";

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

const DRIVER_KIND = "hermesOs";

// Static catalog — kept in sync with hermes-os ProviderManager. The
// driver re-queries /v1/models on snapshot() when the hub is reachable,
// but the model picker needs something to render before that resolves.
const MODELS = {
  default: "gemini",
  options: [
    { id: "council",       label: "Council (multi-agent synthesis via Ollama)" },
    { id: "gemini",        label: "Gemini 2.5 Flash (Antigravity SDK)" },
    { id: "openai",        label: "OpenAI gpt-4o-mini" },
    { id: "anthropic",     label: "Anthropic claude-sonnet-4-5 (via local proxy)" },
    { id: "opencode",      label: "OpenCode Zen (hosted deepseek-v4-flash-free)" },
    { id: "local_claude",  label: "Local Claude Code CLI (host-side)" },
    { id: "local_codex",   label: "Local Codex CLI (host-side)" },
    { id: "mavis",         label: "mavis (MiniMax Code on the Mac, via Tailscale)" },
    { id: "nous",          label: "Nous Research (Hermes family)" },
  ],
};

export interface HermesOsConfig {
  baseUrl: string;
  apiKey?: string;
  defaultModel: string;
  /** Per-turn hard timeout in ms. Defaults to 5 minutes. */
  timeoutMs: number;
  /** Override the user-agent. */
  userAgent: string;
}

function decodeConfig(raw: unknown): HermesOsConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const baseUrlRaw = o.baseUrl ?? o.base_url;
  if (typeof baseUrlRaw !== "string" || !baseUrlRaw) {
    throw new Error("hermes-os: baseUrl is required (e.g. http://127.0.0.1:8001)");
  }
  let baseUrl = baseUrlRaw.replace(/\/+$/, "");
  // Tolerate users typing the OpenAI mount point
  baseUrl = baseUrl.replace(/\/(v1|openai\/v1)$/, "");
  const apiKeyRaw = o.apiKey ?? o.api_key ?? process.env.HUB_API_TOKEN;
  const apiKey = typeof apiKeyRaw === "string" && apiKeyRaw ? apiKeyRaw : undefined;
  const defaultModelRaw = o.defaultModel ?? o.default_model;
  const defaultModel = typeof defaultModelRaw === "string" && defaultModelRaw ? defaultModelRaw : "gemini";
  const timeoutMsRaw = o.timeoutMs ?? o.timeout_ms;
  const timeoutMs = typeof timeoutMsRaw === "number" && timeoutMsRaw > 0 ? timeoutMsRaw : 5 * 60_000;
  const userAgent = typeof o.userAgent === "string" ? o.userAgent : "openmausbot-hermes-os/0.1";
  return { baseUrl, apiKey, defaultModel, timeoutMs, userAgent };
}

function flattenMessages(input: SendTurnInput): { system: string | undefined; prompt: string } {
  // OpenMausBot's SendTurnInput carries a flat {text, system, transcript}.
  // The hub expects an OpenAI messages array. Build it from the fields
  // available, preferring the most informative source.
  const turns: Array<{ role: "user" | "assistant"; text: string }> = input.transcript ?? [];
  const messages: Array<{ role: string; content: string }> = [];
  if (input.system) messages.push({ role: "system", content: input.system });
  for (const t of turns) messages.push({ role: t.role, content: t.text });
  messages.push({ role: "user", content: input.text });
  const system = input.system;
  const prompt = input.text;
  // The hub's _flatten_openai_messages already joins multi-turn content,
  // so we just pass the latest user turn as the prompt and let the hub
  // walk the array. We return the system and prompt here for clarity;
  // the actual HTTP call sends the full messages array below.
  void messages;
  return { system, prompt };
}

export const HermesOsDriver: ProviderDriver<HermesOsConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "hermes-os (Agent OS hub)", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () =>
    decodeConfig({ baseUrl: process.env.HERMES_OS_URL ?? "http://127.0.0.1:8001" }),

  async create(input: DriverCreateInput<HermesOsConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const listeners = new Set<RuntimeEventListener>();
    // one active turn per threadId; the OpenMausBot core is responsible
    // for not starting a second one — but we defend in depth.
    const active = new Map<string, { abort: AbortController; turnId: string; sessionId: string }>();

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) {
        try { l(event); } catch { /* listener errors must not break the run */ }
      }
    };
    const base = (threadId: string, turnId: string, itemId?: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      providerInstanceId: instanceId,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
      ...(itemId ? { itemId } : {}),
    });

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": config.userAgent,
    };
    if (config.apiKey) headers["authorization"] = `Bearer ${config.apiKey}`;

    const snapshot = async (): Promise<ProviderSnapshot> => {
      try {
        const res = await fetch(`${config.baseUrl}/v1/models`, {
          method: "GET",
          headers: { ...headers, "content-type": "application/json" },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          return { state: "unavailable", reason: `hub responded ${res.status}` };
        }
        const j = (await res.json()) as { data?: Array<{ id: string }> };
        const available = (j.data ?? []).map((m) => m.id);
        return {
          state: "available",
          authenticated: !!config.apiKey,
          version: null,
          // expose the seat list on the snapshot for the model picker to consult
          ...({ modelIds: available } as { modelIds: string[] }),
        };
      } catch (e: any) {
        return { state: "unavailable", reason: e?.message ?? String(e) };
      }
    };

    const sendTurn = async (turn: SendTurnInput): Promise<{ turnId: string }> => {
      if (active.has(turn.threadId)) {
        throw new Error("a turn is already running on this thread");
      }
      const turnId = newId();
      const sessionId = newId();
      const itemId = newId();
      active.set(turn.threadId, { abort: new AbortController(), turnId, sessionId });
      try {
        // session lifecycle: started → turn started → content → turn completed → exited
        emit({
          ...base(turn.threadId, turnId),
          type: "session.started",
          sessionId,
          model: turn.model ?? config.defaultModel,
        });
        emit({ ...base(turn.threadId, turnId), type: "turn.started" });

        // Informational notes about unsupported integrations are logged to
        // the native NDJSON stream for debugging, not surfaced as runtime
        // errors. The hub still answers the prompt — these are advisory, not
        // failures. Surfacing them as runtime.error would contradict the
        // eventual turn.completed(ok: true) and (worse) emit a pending
        // activity chip for the tool integrations we never actually started.
        if (turn.integrations?.computer) {
          appendNative(turn.threadId, {
            dir: "out",
            source: "hermes-os-driver",
            msg: { note: "cloud-computer (Box) integration is not supported by the hub; ignoring" },
          });
        }
        if (turn.integrations?.localComputer) {
          appendNative(turn.threadId, {
            dir: "out",
            source: "hermes-os-driver",
            msg: { note: "local computer-use (cua-driver) is not supported by the hub; ignoring" },
          });
        }
        if (turn.integrations?.agents) {
          appendNative(turn.threadId, {
            dir: "out",
            source: "hermes-os-driver",
            msg: { note: "peer-agent comms (council intent) noted but not mounted as MCP tools" },
          });
        }

        const { system } = flattenMessages(turn);
        const messages: Array<{ role: string; content: string }> = [];
        if (system || turn.system) {
          messages.push({ role: "system", content: system ?? turn.system! });
        }
        for (const t of turn.transcript ?? []) {
          messages.push({ role: t.role, content: t.text });
        }
        messages.push({ role: "user", content: turn.text });

        const model = (turn.model ?? config.defaultModel).trim().toLowerCase();
        const body = {
          model,
          messages,
          stream: true,
          // keep the request cheap; the hub will pass these through to the
          // underlying provider if supported, otherwise ignore
          temperature: 0.7,
        };
        const url = `${config.baseUrl}/v1/chat/completions`;
        const nativeRecord = { source: "openai-compat", payload: { url, model, threadId: turn.threadId, turnId } };
        appendNative(turn.threadId, { dir: "out", source: "openmausbot", msg: nativeRecord });

        const ac = active.get(turn.threadId)!.abort;
        const fetchSignal = AbortSignal.any([ac.signal, AbortSignal.timeout(config.timeoutMs!)]);
        // The fetch + the initial response handling are wrapped so that ANY
        // failure (network error, DNS failure, timeout, non-2xx, empty body)
        // emits the required runtime.error + turn.completed(ok: false) +
        // session.exited triple. Previously a thrown fetch would escape the
        // function and the harness would see a rejected promise — no events
        // and a "stuck" turn.
        let res: Response;
        try {
          res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: fetchSignal,
          });
        } catch (e: any) {
          // Sanitize: report a stable code, do not leak the underlying
          // network/DNS error string into the chat UI.
          const isAbort = e?.name === "AbortError";
          const reason = isAbort ? "interrupted" : "error";
          const message = isAbort
            ? `hermes-os: turn interrupted`
            : `hermes-os: hub request failed`;
          emit({ ...base(turn.threadId, turnId), type: "runtime.error", message });
          emit({
            ...base(turn.threadId, turnId),
            type: "turn.completed",
            ok: false,
            stopReason: reason,
            denials: [],
          });
          emit({
            ...base(turn.threadId, turnId),
            type: "session.exited",
            reason,
          });
          return { turnId };
        }

        if (!res.ok) {
          // Sanitize: do NOT include the upstream response body in the
          // runtime.error event. The hub's body may contain stack traces,
          // internal paths, or other content that has no business being
          // surfaced in the chat UI. Report status + a stable code only.
          const stopReason = res.status === 401 ? "auth" : res.status === 429 ? "rate_limit" : "error";
          emit({
            ...base(turn.threadId, turnId),
            type: "runtime.error",
            message: `hermes-os: hub responded ${res.status} ${res.statusText}`,
          });
          emit({
            ...base(turn.threadId, turnId),
            type: "turn.completed",
            ok: false,
            stopReason,
            denials: [],
          });
          emit({
            ...base(turn.threadId, turnId),
            type: "session.exited",
            reason: stopReason,
          });
          return { turnId };
        }
        if (!res.body) {
          emit({
            ...base(turn.threadId, turnId),
            type: "runtime.error",
            message: "hermes-os: hub returned an empty response body",
          });
          emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: false, stopReason: "error" });
          emit({ ...base(turn.threadId, turnId), type: "session.exited", reason: "error" });
          return { turnId };
        }

        // Parse SSE: lines starting with "data: " until "[DONE]"
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let fullText = "";
        let lastUsage: { input: number; output: number } | null = null;
        let stopReason: string | null = null;

        // No item.started for assistant_text: the hub delivers the model
        // output as one terminal chunk, not a stream of progress. Emitting
        // a placeholder item.started (itemType: tool) would create a
        // pending activity chip in the UI that never resolves to a
        // matching completed: assistant_text. We only emit the terminal
        // item.completed: assistant_text below.

        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf("\n")) !== -1) {
              const line = buf.slice(0, nl).replace(/\r$/, "");
              buf = buf.slice(nl + 1);
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (payload === "[DONE]") {
                buf = "__DONE__";
                break;
              }
              if (!payload) continue;
              let parsed: any;
              try { parsed = JSON.parse(payload); } catch { continue; }
              appendNative(turn.threadId, { dir: "in", source: "hermes-os", msg: parsed });
              const choice = parsed?.choices?.[0];
              if (!choice) continue;
              const delta = choice.delta ?? choice.message;
              const piece = delta?.content;
              if (typeof piece === "string" && piece.length > 0) {
                fullText += piece;
                emit({
                  ...base(turn.threadId, turnId, itemId),
                  type: "content.delta",
                  streamKind: "assistant_text",
                  delta: piece,
                });
              }
              if (typeof choice.finish_reason === "string" && choice.finish_reason) {
                stopReason = choice.finish_reason;
              }
              if (parsed.usage && typeof parsed.usage === "object") {
                const u = parsed.usage;
                lastUsage = {
                  input: Number(u.prompt_tokens ?? 0),
                  output: Number(u.completion_tokens ?? 0),
                };
              }
            }
            if (buf === "__DONE__") break;
          }
        } catch (e: any) {
          if (e?.name === "AbortError") {
            stopReason = stopReason ?? "interrupted";
          } else {
            emit({
              ...base(turn.threadId, turnId),
              type: "runtime.error",
              message: `hermes-os: stream read error: ${e?.message ?? String(e)}`,
            });
            stopReason = "error";
          }
        } finally {
          try { reader.releaseLock(); } catch { /* already released */ }
        }

        if (fullText) {
          emit({
            ...base(turn.threadId, turnId, itemId),
            type: "item.completed",
            itemType: "assistant_text",
            text: fullText,
          });
        }
        if (lastUsage) {
          emit({
            ...base(turn.threadId, turnId),
            type: "thread.token-usage.updated",
            input: lastUsage.input,
            output: lastUsage.output,
          });
        }
        emit({
          ...base(turn.threadId, turnId),
          type: "turn.completed",
          ok: stopReason !== "error" && stopReason !== "interrupted",
          stopReason,
          denials: [],
        });
        // The hub doesn't carry long-lived sessions — each call is fresh.
        // Emit session.exited so the UI can mark the chat as "no resume".
        emit({
          ...base(turn.threadId, turnId),
          type: "session.exited",
          reason: stopReason ?? "stop",
        });
        return { turnId };
      } finally {
        active.delete(turn.threadId);
      }
    };

    const interruptTurn = async (threadId: string, _turnId?: string): Promise<void> => {
      const entry = active.get(threadId);
      if (entry) entry.abort.abort();
    };

    const respondToRequest = async (
      _threadId: string,
      _requestId: string,
      decision: { behavior: "allow" | "deny" | "answer"; message?: string },
    ): Promise<void> => {
      // hermes-os handles its own permission flow via the underlying CLI
      // providers (Claude/Codex etc.). When invoked through this driver,
      // permission requests are surfaced as runtime.error events and we
      // auto-deny with a note. The OpenMausBot core can override by
      // calling interruptTurn() and re-sending.
      emit({
        ...base(_threadId, active.get(_threadId)?.turnId ?? newId()),
        type: "request.resolved",
        behavior: decision.behavior,
        source: "hermes-os-driver",
      });
    };

    const hasSession = (_threadId: string): boolean => false; // no long-lived sessions

    const stopAll = async (): Promise<void> => {
      for (const [, entry] of active) entry.abort.abort();
      active.clear();
    };

    const onEvent = (listener: RuntimeEventListener): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };

    const generateText = async (prompt: string): Promise<string> => {
      const fakeTurn: SendTurnInput = {
        threadId: newId(),
        text: prompt,
        model: config.defaultModel,
      };
      let text = "";
      const unsub = onEvent((ev) => {
        if (ev.type === "item.completed" && ev.itemType === "assistant_text") text = ev.text;
      });
      try {
        await sendTurn(fakeTurn);
      } finally {
        unsub();
      }
      if (!text) throw new Error("hermes-os: generateText produced no text");
      return text;
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
        capabilities: {
          sessionModelSwitch: "in-session",
          // We do NOT advertise agentsMcp. The hub has a "council" intent
          // that performs peer-agent comms, but the driver does not
          // mount list_bots / ask_bot as MCP tools on the underlying CLI.
          // Claiming the capability without wiring it causes the harness
          // to prompt the model for tools the agent can't actually call.
          // Flip this to true only when the corresponding MCP server is
          // mounted inside the driver.
          agentsMcp: false,
        },
        sendTurn,
        interruptTurn,
        respondToRequest,
        hasSession,
        stopAll,
        onEvent,
      },
      generateText,
      async dispose(): Promise<void> {
        await stopAll();
        listeners.clear();
      },
    } satisfies ProviderInstance;
  },
};
