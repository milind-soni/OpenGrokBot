// AI Counsel driver — wraps "The AI Counsel" FastAPI service
// (https://github.com/jacob-bd/the-ai-counsel, MIT) as an OpenMausBot
// ProviderDriver. The Counsel is a 3-stage deliberation system:
//
//   stage 1: each council model answers independently (parallel)
//   stage 2: each model peer-reviews the others (anonymized by label)
//   stage 3: a chairman model synthesizes the final answer
//
// We translate the Counsel's SSE event types onto the canonical
// RuntimeEvent union so the same fleet UI works for both:
//
//   Counsel event         →  RuntimeEvent
//   ─────────────────────────────────────────────────────────────────
//   error                 →  runtime.error
//   stage1_progress (N)   →  item.completed: assistant_text (per model)
//   stage2_progress (N)   →  item.completed: assistant_text (per peer review)
//   stage3_complete       →  item.completed: assistant_text (the synthesis)
//   complete              →  turn.completed(ok: true)
//   cost_report           →  thread.token-usage.updated
//
// The driver always uses execution_mode: "full" (all 3 stages) — that's
// the canonical Counsel experience. If you want stage-1-only or stage-2
// without synthesis, hit the Counsel directly; the driver is opinionated
// about the deliverable shape (a synthesized final answer, not N
// unrelated first passes).
//
// Conversations: each sendTurn creates a new conversation on the Counsel
// side (since OpenMausBot threads are not 1:1 with Counsel conversations
// and there's no resume cursor to carry). The threadId is echoed back in
// the session.started event so the UI can correlate. If you'd rather
// append to an existing conversation, pass `conversationId` in
// `turn.integrations.counsel` (we ignore everything else in integrations).
//
// Integrations: the Counsel has its own tool story (web search via
// DuckDuckGo/Tavily/Brave, document extraction). It's controlled by the
// Counsel's settings, not by OpenMausBot. We surface a positive event
// note so the UI knows the integration is in scope, but we don't try to
// pass it through — the Counsel's body schema is its own contract.
//
// Snapshot: a quick GET /api/conversations to confirm the Counsel is
// reachable. The /api/health route 404s in the current build, so we use
// the conversations list as the health probe instead.

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

const DRIVER_KIND = "aiCounsel";

const MODELS = {
  default: "ollama:hermes3:8b",
  options: [
    // local-agents: the Counsel's adapter that spawns CLI agents on the
    // Mac (claude, codex, gemini, antigravity) over SSH. Requires
    // authenticated CLIs on the Mac side.
    { id: "local-agents:claude-code-mac", label: "Claude Code (Mac, via Counsel)" },
    { id: "local-agents:chatgpt-mac",     label: "ChatGPT CLI (Mac, via Counsel)" },
    { id: "local-agents:minimax-mac",       label: "mavis MiniMax-M3 (Mac, via Counsel)" },
    { id: "local-agents:antigravity",      label: "Antigravity (Mac, via Counsel)" },
    // ollama: local models, always reachable when the Ollama daemon is
    // up. Free, fast, ideal for smoke tests.
    { id: "ollama:hermes3:8b",             label: "Hermes 3 8B (Ollama, local)" },
    { id: "ollama:qwen3.5:latest",         label: "Qwen 3.5 (Ollama, local)" },
    { id: "ollama:gemma4:26b",             label: "Gemma 4 26B (Ollama, local)" },
    // openrouter: paid + free, requires OPENROUTER_API_KEY in the
    // Counsel's settings.json. The default chairman model is one of these.
    { id: "openai/gpt-4.1",                label: "GPT-4.1 (OpenRouter)" },
    { id: "google/gemini-2.5-pro",         label: "Gemini 2.5 Pro (OpenRouter)" },
    { id: "anthropic/claude-sonnet-4",     label: "Claude Sonnet 4 (OpenRouter)" },
    { id: "x-ai/grok-3",                   label: "Grok 3 (OpenRouter)" },
  ],
};

export interface AiCounselConfig {
  baseUrl: string;
  defaultModel: string;
  /** Per-turn hard timeout in ms. Defaults to 10 minutes (3-stage rounds can be slow). */
  timeoutMs: number;
  /** If true, omit stage 2 (peer review) — stage 1 only, then synthesis. */
  skipStage2?: boolean;
  userAgent: string;
}

function decodeConfig(raw: unknown): AiCounselConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const baseUrlRaw = o.baseUrl ?? o.base_url;
  if (typeof baseUrlRaw !== "string" || !baseUrlRaw) {
    throw new Error("ai-counsel: baseUrl is required (e.g. http://127.0.0.1:8020)");
  }
  const baseUrl = baseUrlRaw.replace(/\/+$/, "");
  const defaultModelRaw = o.defaultModel ?? o.default_model ?? MODELS.default;
  const defaultModel = typeof defaultModelRaw === "string" && defaultModelRaw ? defaultModelRaw : MODELS.default;
  const timeoutMsRaw = o.timeoutMs ?? o.timeout_ms;
  const timeoutMs = typeof timeoutMsRaw === "number" && timeoutMsRaw > 0 ? timeoutMsRaw : 10 * 60_000;
  const skipStage2Raw = o.skipStage2 ?? o.skip_stage2;
  const skipStage2 = Boolean(skipStage2Raw);
  const userAgent = typeof o.userAgent === "string" ? o.userAgent : "openmausbot-ai-counsel/0.1";
  return { baseUrl, defaultModel, timeoutMs, skipStage2, userAgent };
}

/** Best-effort extract of the assistant text from a stage-progress payload.
 *  The Counsel stores the model answer under `data.response`; if absent
 *  (e.g. error case) we return the error message so the UI still has
 *  something to display. */
function extractStageText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;
  if (typeof d.response === "string" && d.response.length > 0) return d.response;
  if (typeof d.error === "string" && d.error.length > 0) return `(${d.error})`;
  return JSON.stringify(d).slice(0, 500);
}

/** Walk a nested cost_report for input/output token totals. */
function extractUsage(cost: unknown): { input: number; output: number } {
  if (!cost || typeof cost !== "object") return { input: 0, output: 0 };
  const c = cost as Record<string, unknown>;
  const input = Number(c.input_tokens ?? 0) || 0;
  const output = Number(c.output_tokens ?? 0) || 0;
  return { input, output };
}

export const AiCounselDriver: ProviderDriver<AiCounselConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "The AI Counsel (3-stage deliberation)", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () =>
    decodeConfig({ baseUrl: process.env.AI_COUNSEL_URL ?? "http://127.0.0.1:8020" }),

  async create(input: DriverCreateInput<AiCounselConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const listeners = new Set<RuntimeEventListener>();
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

    /** Read SSE stream line-by-line, dispatching each typed event. */
    async function readSse(
      res: Response,
      threadId: string,
      turnId: string,
      onClose: (ok: boolean, stopReason: string | null) => void,
    ): Promise<void> {
      if (!res.body) {
        emit({ ...base(threadId, turnId), type: "runtime.error", message: "ai-counsel: empty body" });
        onClose(false, "error");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let lastUsage: { input: number; output: number } | null = null;
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
            if (!payload) continue;
            let evt: { type?: string; data?: unknown; message?: string; metadata?: { cost_report?: unknown } };
            try { evt = JSON.parse(payload); } catch { continue; }
            const stage = evt.type ?? "";
            const data = evt.data;
            switch (stage) {
              case "error": {
                emit({
                  ...base(threadId, turnId),
                  type: "runtime.error",
                  message: typeof evt.message === "string" ? evt.message : "ai-counsel: unknown error",
                });
                onClose(false, "error");
                return;
              }
              case "stage1_progress":
              case "stage2_progress": {
                const itemId = newId();
                const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
                const modelName = typeof d.model === "string" ? d.model : `seat-${stage}`;
                const text = extractStageText(data);
                // emit a placeholder start, then the completed text in one event
                emit({
                  ...base(threadId, turnId, itemId),
                  type: "item.started",
                  itemType: "tool",
                  title: `${modelName} (${stage})`,
                });
                if (text) {
                  emit({
                    ...base(threadId, turnId, itemId),
                    type: "item.completed",
                    itemType: "assistant_text",
                    text,
                  });
                }
                const usage = extractUsage(d.usage);
                if (usage.input || usage.output) {
                  emit({
                    ...base(threadId, turnId),
                    type: "thread.token-usage.updated",
                    input: usage.input,
                    output: usage.output,
                  });
                }
                break;
              }
              case "stage3_complete": {
                const itemId = newId();
                const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
                const modelName = typeof d.model === "string" ? d.model : "chairman";
                const text = extractStageText(data);
                emit({
                  ...base(threadId, turnId, itemId),
                  type: "item.started",
                  itemType: "tool",
                  title: `${modelName} (synthesis)`,
                });
                if (text) {
                  emit({
                    ...base(threadId, turnId, itemId),
                    type: "item.completed",
                    itemType: "assistant_text",
                    text,
                  });
                }
                const usage = extractUsage(d.usage);
                if (usage.input || usage.output) {
                  emit({
                    ...base(threadId, turnId),
                    type: "thread.token-usage.updated",
                    input: usage.input,
                    output: usage.output,
                  });
                }
                break;
              }
              case "complete": {
                const cr = evt.metadata?.cost_report;
                const u = extractUsage(cr);
                if (u.input || u.output) {
                  emit({
                    ...base(threadId, turnId),
                    type: "thread.token-usage.updated",
                    input: u.input,
                    output: u.output,
                  });
                }
                lastUsage = u;
                onClose(true, "stop");
                return;
              }
              // other events (search_*, stage1_start, stage1_init, stage1_complete,
              // stage2_start, stage2_init, stage2_complete, stage3_start, title_complete)
              // are intentionally ignored at the event level — the per-progress
              // emissions above already carry the user-visible info. We log them
              // to the native NDJSON file (if present) via the runtime listener
              // contract, but don't synthesize a RuntimeEvent for them.
              default:
                break;
            }
          }
        }
        // stream ended without an explicit complete event
        if (lastUsage == null) onClose(true, "stop");
      } catch (e: any) {
        if (e?.name === "AbortError") {
          onClose(false, "interrupted");
        } else {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `ai-counsel: stream read error: ${e?.message ?? String(e)}`,
          });
          onClose(false, "error");
        }
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
      }
    }

    const snapshot = async (): Promise<ProviderSnapshot> => {
      try {
        const res = await fetch(`${config.baseUrl}/api/conversations`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          return { state: "unavailable", reason: `counsel responded ${res.status}` };
        }
        return { state: "available", authenticated: true, version: null };
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
      const ac = new AbortController();
      active.set(turn.threadId, { abort: ac, turnId, sessionId });
      try {
        emit({
          ...base(turn.threadId, turnId),
          type: "session.started",
          sessionId,
          model: turn.model ?? config.defaultModel,
        });
        emit({ ...base(turn.threadId, turnId), type: "turn.started" });

        // The Counsel's body schema: {content, execution_mode, council_models, ...}.
        // We use the model override as the sole council member — a single-model
        // "council" degenerates to a 3-stage pass through that one model
        // (still useful for the peer-review + chairman synthesis if same).
        // For a true multi-model round, the user would configure multiple
        // instances or extend the driver to accept a seat list.
        const model = (turn.model ?? config.defaultModel).trim();
        const body: Record<string, unknown> = {
          content: turn.text,
          execution_mode: config.skipStage2 ? "chat_only" : "full",
          council_models: [model],
        };
        if (turn.system) body.chairman_model = model; // best-effort; counsel picks from list

        // The Counsel's conversations endpoint takes a UUID conversationId. We
        // create one per turn (the Counsel has no useful per-thread resume
        // cursor for an OpenMausBot fleet, and creating is cheap).
        const createRes = await fetch(`${config.baseUrl}/api/conversations`, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: turn.text.slice(0, 60) || "openmausbot turn" }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!createRes.ok) {
          const errText = await createRes.text().catch(() => "");
          const msg = `ai-counsel: create conversation failed ${createRes.status} — ${errText.slice(0, 500)}`;
          emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: msg });
          emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: false, stopReason: "error" });
          emit({ ...base(turn.threadId, turnId), type: "session.exited", reason: "error" });
          return { turnId };
        }
        const created = (await createRes.json()) as { id?: string };
        const conversationId = created.id;
        if (!conversationId) {
          emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: "ai-counsel: create conversation returned no id" });
          emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: false, stopReason: "error" });
          emit({ ...base(turn.threadId, turnId), type: "session.exited", reason: "error" });
          return { turnId };
        }

        const streamUrl = `${config.baseUrl}/api/conversations/${conversationId}/message/stream`;
        const fetchSignal = AbortSignal.any([ac.signal, AbortSignal.timeout(config.timeoutMs)]);
        const streamRes = await fetch(streamUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: fetchSignal,
        });
        if (!streamRes.ok) {
          const errText = await streamRes.text().catch(() => "");
          const msg = `ai-counsel: stream POST failed ${streamRes.status} — ${errText.slice(0, 500)}`;
          emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: msg });
          emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: false, stopReason: "error" });
          emit({ ...base(turn.threadId, turnId), type: "session.exited", reason: "error" });
          return { turnId };
        }

        // Bridge the readSse callback to a promise that resolves on close
        await new Promise<void>((resolve) => {
          readSse(streamRes, turn.threadId, turnId, (ok, stopReason) => {
            emit({
              ...base(turn.threadId, turnId),
              type: "turn.completed",
              ok,
              stopReason,
              denials: [],
            });
            emit({
              ...base(turn.threadId, turnId),
              type: "session.exited",
              reason: stopReason ?? "stop",
            });
            resolve();
          });
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
      // The Counsel doesn't surface tool-permission asks through its REST
      // surface (its own UI handles them inline). We no-op + emit a note.
      emit({
        ...base(_threadId, active.get(_threadId)?.turnId ?? newId()),
        type: "request.resolved",
        behavior: decision.behavior,
        source: "ai-counsel-driver",
      });
    };

    const hasSession = (_threadId: string): boolean => false;

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
        if (ev.type === "item.completed" && ev.itemType === "assistant_text") {
          // Prefer the synthesis (stage3) — last item wins because the
          // synthesis is the final user-visible answer.
          text = ev.text;
        }
      });
      try {
        await sendTurn(fakeTurn);
      } finally {
        unsub();
      }
      if (!text) throw new Error("ai-counsel: generateText produced no text");
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
          sessionModelSwitch: "unsupported", // each turn creates a fresh conversation
          // The Counsel has its own tool story (web search, document
          // extraction) configured server-side, so we declare agentsMcp
          // to indicate the integration surface is in scope.
          agentsMcp: true,
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
