// Grok Build driver — the official `grok` CLI headless over its ACP (Agent
// Client Protocol) stdio interface: JSON-RPC 2.0, newline-delimited, spawned
// as `grok … agent stdio`. This is the subscription-login path
// (~/.grok/auth.json), NOT the xAI API key — the API-backed driver lives in
// drivers/grok.ts and stays separate.
//
// Unlike codex's app-server, ACP has no `turn/completed` notification: the
// `session/prompt` RPC *result* is the completion signal (it carries the
// stopReason and the usage counters), which is also why racing the `_x.ai/*`
// side-channel notifications is pointless — they arrive first but the result
// is authoritative. Permission requests arrive as server→client JSON-RPC
// requests (`session/request_permission`) and surface as canonical
// request.opened events, answered via respondToRequest — and answered
// fail-closed: nothing is approved unless the agent explicitly offered an
// `allow`-kind option, because option ORDER is not a security contract.
//
// The handshake is initialize → authenticate(cached_token) → session/*. The
// authenticate step is not optional: without it the agent has no account
// bound, and a missing cached_token means the user never ran `grok login`.
//
// resumeCursor is the ACP sessionId; a later turn tries session/load and
// falls back to a fresh session/new. session/load REPLAYS the whole history
// as ordinary session/update notifications, so updates are double-gated:
// nothing is emitted before the prompt is sent, and anything flagged
// `_meta.isReplay` is dropped. Verified against grok 1.0.0.
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { newEventId, newId } from "../contracts.js";
import { appendNative } from "./native.js";
const DRIVER_KIND = "grokAgent";
// The CLI catalog is account-driven (`grok models` reports exactly one today);
// this should eventually be read from the initialize result's
// `_meta.modelState.availableModels` instead of being hardcoded.
const MODELS = {
    default: "grok-4.5",
    options: [{ id: "grok-4.5", label: "Grok 4.5" }],
};
function decodeConfig(raw) {
    const o = (raw ?? {});
    return {
        cli: typeof o.cli === "string" ? o.cli : "grok",
        fullAuto: o.fullAuto === true,
        workspace: typeof o.workspace === "string" ? o.workspace : undefined,
    };
}
const DENY_TIMEOUT_NOTE = "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";
const LOGIN_NOTE = "Grok CLI is not signed in — run `grok login` in a terminal";
// RPC deadlines. session/prompt gets none: a turn legitimately runs for
// minutes, and interruptTurn plus the child `close` handler cover a real hang.
const INIT_TIMEOUT = 20_000;
const NEW_SESSION_TIMEOUT = 30_000;
const LOAD_SESSION_TIMEOUT = 120_000; // history replay on a long thread is slow
export const GrokAgentDriver = {
    driverKind: DRIVER_KIND,
    metadata: { displayName: "Grok", supportsMultipleInstances: true },
    models: MODELS,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),
    async create(input) {
        const { instanceId, config } = input;
        const listeners = new Set();
        const active = new Map();
        const emit = (event) => {
            for (const l of [...listeners])
                l(event);
        };
        const base = (threadId, turnId) => ({
            eventId: newEventId(),
            provider: DRIVER_KIND,
            threadId,
            turnId,
            createdAt: new Date().toISOString(),
        });
        const sendTurn = async (turn) => {
            const { threadId } = turn;
            if (active.has(threadId))
                throw new Error("a turn is already running on this thread");
            const turnId = newId();
            // homedir is the fleet-wide convention (claude and codex do the same);
            // config.workspace lets an instance be sandboxed to one directory
            const cwd = turn.cwd ?? config.workspace ?? homedir();
            const env = { ...process.env };
            // the CLI owns its own grok.com login; a leaked API key silently flips
            // billing from the subscription to pay-as-you-go
            delete env.XAI_API_KEY;
            // --permission-mode must always be explicit: ~/.grok/config.toml may set
            // permission_mode = "always-approve", which would silently make every
            // session yolo and never fire session/request_permission
            const args = [
                "--permission-mode",
                config.fullAuto ? "bypassPermissions" : "default",
                ...(turn.model ? ["-m", turn.model] : []),
                "agent",
                "stdio",
            ];
            const child = spawn(config.cli, args, {
                cwd,
                env,
                stdio: ["pipe", "pipe", "pipe"],
                detached: true,
            });
            // promptSent gates every session/update: session/load replays the whole
            // history through the same channel before the real turn begins
            const state = { settled: false, promptSent: false, text: "" };
            const asks = new Map();
            let nextId = 1;
            let sessionId = null;
            let interruptTimer = null;
            const rpcPending = new Map();
            const send = (obj) => {
                try {
                    child.stdin.write(JSON.stringify(obj) + "\n");
                }
                catch { }
                appendNative(threadId, { dir: "out", source: "grok.acp", msg: obj });
            };
            const request = (method, params, timeoutMs) => new Promise((resolve, reject) => {
                const id = nextId++;
                let timer = null;
                if (timeoutMs) {
                    timer = setTimeout(() => {
                        rpcPending.delete(id);
                        reject(new Error(`${method} timed out`));
                    }, timeoutMs);
                    timer.unref?.();
                }
                rpcPending.set(id, { resolve, reject, timer });
                send({ jsonrpc: "2.0", id, method, params });
            });
            const stop = () => {
                try {
                    process.kill(-child.pid, "SIGTERM");
                }
                catch {
                    try {
                        child.kill("SIGTERM");
                    }
                    catch { }
                }
            };
            const settle = (ok, stopReason) => {
                if (state.settled)
                    return;
                state.settled = true;
                if (interruptTimer)
                    clearTimeout(interruptTimer);
                for (const finish of [...asks.values()])
                    finish("cancel");
                for (const p of rpcPending.values()) {
                    if (p.timer)
                        clearTimeout(p.timer);
                    p.reject(new Error("turn settled"));
                }
                rpcPending.clear();
                active.delete(threadId);
                // chunks stream token by token — the transcript entry is the sum
                if (state.text.trim()) {
                    emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: state.text });
                }
                emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null });
                stop(); // the agent process does not exit on its own
            };
            // server→client permission request → canonical request.opened
            const handleServerRequest = (msg) => {
                if (msg.method !== "session/request_permission") {
                    // never leave an unknown server request hanging — the agent blocks
                    return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
                }
                const params = msg.params ?? {};
                const options = Array.isArray(params.options) ? params.options : [];
                // fail-closed: only an explicitly-kinded option counts. Falling back to
                // options[0] would turn a malformed request into a silent approval.
                const optionFor = (want) => options.find((o) => String(o.kind ?? "").startsWith(want) && typeof o.optionId === "string")?.optionId ?? null;
                // "cancelled" is always a valid ACP outcome — it is the safe answer
                const cancelled = { outcome: { outcome: "cancelled" } };
                const missing = (want) => emit({
                    ...base(threadId, turnId),
                    type: "runtime.error",
                    message: `grok offered no "${want}" permission option — cancelling the request instead of guessing`,
                });
                const toolCall = params.toolCall ?? {};
                if (config.fullAuto) {
                    const allow = optionFor("allow");
                    if (!allow)
                        missing("allow");
                    return send({
                        jsonrpc: "2.0",
                        id: msg.id,
                        result: allow ? { outcome: { outcome: "selected", optionId: allow } } : cancelled,
                    });
                }
                const kind = String(toolCall.kind ?? "");
                const tool = kind === "execute" ? "shell" : kind === "edit" ? "edit" : kind || "tool";
                const summary = String(toolCall.rawInput?.command ?? toolCall.title ?? tool).slice(0, 200);
                const requestId = newId();
                const finish = (behavior) => {
                    if (!asks.delete(requestId))
                        return;
                    clearTimeout(timer);
                    const want = behavior === "allow" ? "allow" : "reject";
                    const optionId = behavior === "cancel" ? null : optionFor(want);
                    if (behavior !== "cancel" && !optionId)
                        missing(want);
                    send({
                        jsonrpc: "2.0",
                        id: msg.id,
                        result: optionId ? { outcome: { outcome: "selected", optionId } } : cancelled,
                    });
                    // a settle-cancel (or a fail-closed cancel) still resolves the card:
                    // source "system" marks it dismissed rather than answered by a human
                    emit({
                        ...base(threadId, turnId),
                        type: "request.resolved",
                        requestId,
                        behavior: optionId && behavior === "allow" ? "allow" : "deny",
                        source: optionId ? "user" : "system",
                    });
                };
                const timer = setTimeout(() => {
                    emit({ ...base(threadId, turnId), type: "runtime.error", message: DENY_TIMEOUT_NOTE });
                    finish("deny");
                }, 15 * 60_000);
                timer.unref?.();
                asks.set(requestId, finish);
                emit({
                    ...base(threadId, turnId),
                    type: "request.opened",
                    requestId,
                    requestType: "permission",
                    tool,
                    summary,
                });
            };
            const handleNotification = (msg) => {
                // `_x.ai/*` notifications are teed to the native log but never
                // normalized: the session/prompt result is the single settle signal
                if (msg.method !== "session/update")
                    return;
                const p = msg.params ?? {};
                if (!state.promptSent || p._meta?.isReplay === true)
                    return;
                const u = p.update ?? {};
                switch (u.sessionUpdate) {
                    case "agent_message_chunk": {
                        const delta = u.content?.text;
                        if (typeof delta === "string" && delta) {
                            state.text += delta;
                            emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
                        }
                        break;
                    }
                    case "agent_thought_chunk": {
                        const delta = u.content?.text;
                        if (typeof delta === "string" && delta) {
                            emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta });
                        }
                        break;
                    }
                    case "tool_call": {
                        emit({
                            ...base(threadId, turnId),
                            type: "item.started",
                            itemType: "tool",
                            itemId: u.toolCallId,
                            title: String(u.rawInput?.command ?? u.title ?? "tool").slice(0, 80),
                        });
                        break;
                    }
                    case "tool_call_update": {
                        // status streams in_progress first — only the terminal one counts
                        if (u.status === "completed" || u.status === "failed") {
                            emit({
                                ...base(threadId, turnId),
                                type: "item.completed",
                                itemType: "tool",
                                itemId: u.toolCallId,
                                ok: u.status !== "failed",
                            });
                        }
                        break;
                    }
                }
            };
            let buf = "";
            child.stdout.on("data", (chunk) => {
                buf += chunk;
                let nl;
                while ((nl = buf.indexOf("\n")) !== -1) {
                    const line = buf.slice(0, nl);
                    buf = buf.slice(nl + 1);
                    if (!line.trim())
                        continue;
                    let msg;
                    try {
                        msg = JSON.parse(line);
                    }
                    catch {
                        continue;
                    }
                    appendNative(threadId, { dir: "in", source: "grok.acp", msg });
                    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
                        const pend = rpcPending.get(msg.id);
                        if (pend) {
                            rpcPending.delete(msg.id);
                            if (pend.timer)
                                clearTimeout(pend.timer);
                            msg.error ? pend.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : pend.resolve(msg.result);
                        }
                    }
                    else if (msg.id !== undefined && msg.method) {
                        handleServerRequest(msg);
                    }
                    else if (msg.method) {
                        handleNotification(msg);
                    }
                }
            });
            let stderr = "";
            child.stderr.on("data", (c) => {
                stderr += c;
                if (stderr.length > 8192)
                    stderr = stderr.slice(-8192);
            });
            child.on("error", (e) => {
                emit({ ...base(threadId, turnId), type: "runtime.error", message: `spawn failed: ${e.message}` });
                settle(false, "spawn_error");
            });
            child.on("close", (code) => {
                if (!state.settled) {
                    emit({
                        ...base(threadId, turnId),
                        type: "runtime.error",
                        message: `grok exited ${code} before the prompt result${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
                    });
                    settle(false, "exit_before_result");
                }
            });
            const interrupt = () => {
                // a notification, no id: the pending session/prompt then resolves with
                // stopReason "cancelled". Kill the group if it never does.
                if (sessionId)
                    send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
                else
                    stop();
                if (interruptTimer)
                    clearTimeout(interruptTimer);
                interruptTimer = setTimeout(() => settle(true, "cancelled"), 5_000);
                interruptTimer.unref?.();
            };
            active.set(threadId, { stop, interrupt, turnId, asks });
            emit({ ...base(threadId, turnId), type: "turn.started" });
            // handshake + kickoff; any refusal surfaces as failure, not a hang
            (async () => {
                try {
                    const init = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }, INIT_TIMEOUT);
                    // bind the grok.com subscription login. No API-key fallback exists
                    // here by design — an unauthenticated CLI is a user action, not
                    // something to paper over with a key.
                    const methods = Array.isArray(init?.authMethods) ? init.authMethods : [];
                    if (!methods.some((m) => m.id === "cached_token"))
                        throw new Error(LOGIN_NOTE);
                    try {
                        await request("authenticate", { methodId: "cached_token" }, INIT_TIMEOUT);
                    }
                    catch {
                        throw new Error(LOGIN_NOTE);
                    }
                    const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
                    if (cursor) {
                        try {
                            // mcpServers is empty: turn.integrations (Composio / the cloud
                            // computer / the local cua daemon) is not wired to this driver
                            // yet. The agent advertises mcpCapabilities http+sse, so a
                            // follow-up can map composio onto an ACP mcpServer entry; until
                            // then bots here have Grok Build's native tools only.
                            await request("session/load", { sessionId: cursor, cwd, mcpServers: [] }, LOAD_SESSION_TIMEOUT);
                            sessionId = cursor;
                        }
                        catch {
                            /* session gone, load unsupported, or too slow — start fresh */
                        }
                    }
                    if (!sessionId) {
                        const started = await request("session/new", { cwd, mcpServers: [] }, NEW_SESSION_TIMEOUT);
                        sessionId = typeof started?.sessionId === "string" ? started.sessionId : null;
                        if (!sessionId)
                            throw new Error("session/new returned no sessionId");
                    }
                    emit({
                        ...base(threadId, turnId),
                        type: "session.started",
                        sessionId,
                        model: init?._meta?.modelState?.currentModelId ?? turn.model ?? null,
                    });
                    // `--append-system-prompt`/`--rules` are accepted by the CLI but do
                    // NOT reach the agent-stdio system prompt (verified against 1.0.0),
                    // so the persona is prepended codex-style
                    state.promptSent = true;
                    const result = await request("session/prompt", {
                        sessionId,
                        prompt: [{ type: "text", text: turn.system ? `${turn.system}\n\n${turn.text}` : turn.text }],
                    });
                    const usage = result?._meta ?? {};
                    if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
                        emit({
                            ...base(threadId, turnId),
                            type: "thread.token-usage.updated",
                            input: usage.inputTokens ?? 0,
                            output: usage.outputTokens ?? 0,
                        });
                    }
                    const reason = result?.stopReason;
                    // "cancelled" is a user deny or an interrupt, not a failure
                    if (reason === "end_turn")
                        settle(true, null);
                    else if (reason === "cancelled")
                        settle(true, "cancelled");
                    else
                        settle(false, reason ?? "failed");
                }
                catch (e) {
                    if (!state.settled) {
                        const message = e.message;
                        emit({ ...base(threadId, turnId), type: "runtime.error", message });
                        settle(false, message === LOGIN_NOTE ? "auth_required" : "rpc_error");
                    }
                }
            })();
            return { turnId };
        };
        const snapshot = async () => {
            const version = await new Promise((resolve) => {
                execFile(config.cli, ["--version"], { timeout: 8000 }, (err, stdout) => resolve(err ? null : stdout.trim()));
            });
            if (!version)
                return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
            const authenticated = existsSync(join(homedir(), ".grok", "auth.json"));
            return { state: "available", version, authenticated };
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
                capabilities: { sessionModelSwitch: "unsupported" },
                sendTurn,
                interruptTurn: async (threadId) => active.get(threadId)?.interrupt(),
                respondToRequest: async (threadId, requestId, decision) => {
                    const turn = active.get(threadId);
                    const finish = turn?.asks.get(requestId);
                    if (!finish)
                        throw new Error("no such pending request");
                    // fail-closed: only an explicit "allow" approves. ACP has no
                    // free-text ask, so "answer" — and anything unrecognized — is a deny.
                    finish(decision.behavior === "allow" ? "allow" : "deny");
                },
                hasSession: (threadId) => active.has(threadId),
                stopAll: async () => {
                    for (const { stop } of active.values())
                        stop();
                },
                onEvent: (listener) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
            },
            dispose: async () => {
                for (const { stop } of active.values())
                    stop();
                listeners.clear();
            },
        };
    },
};
