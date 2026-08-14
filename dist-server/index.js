// OpenMausBot server — the harness host. Clients hold no transports
// (upstream rule): the React app dispatches typed commands over HTTP and
// folds one SSE event stream; every provider process runs here.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as box from "./box.js";
import * as composio from "./composio.js";
import { ensureDirs, instanceConfigs, loadConfig, saveConfig, EVENTS_DIR, NATIVE_DIR } from "./config.js";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.js";
import { EventBus } from "./harness/bus.js";
import { ProviderRegistry } from "./harness/registry.js";
import { mentionedBots, Store } from "./store.js";
const PORT = Number(process.env.OMB_PORT || process.env.OGB_PORT || 8799);
const STATIC_DIR = process.env.OMB_STATIC_DIR || null;
const MIME = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json",
    ".woff2": "font/woff2",
};
ensureDirs();
const cfg = loadConfig();
const registry = new ProviderRegistry(BUILT_IN_DRIVERS);
await registry.load(instanceConfigs(cfg));
const bus = new EventBus();
bus.attach(registry.instances());
// ── peer-agent comms wiring ────────────────────────────────────────────
// A shared secret guards the localhost-only /api/internal endpoints the
// agents-proxy calls; regenerated each boot (the proxy gets it via env).
const COMMS_TOKEN = randomBytes(24).toString("hex");
// Cap message chains: depth 0 = a user-initiated turn (may ask a peer);
// a peer invoked via ask_bot runs at depth 1 and gets NO agents tool, so
// A→B is allowed but B→C (and A→B→A loops) never start.
const MAX_COMMS_DEPTH = 1;
// proxy entry: .ts in dev (node type-strips), .js in the packaged dist-server
const agentsProxyPath = (() => {
    const ts = join(dirname(fileURLToPath(import.meta.url)), "drivers", "agents-proxy.ts");
    return existsSync(ts) ? ts : ts.replace(/\.ts$/, ".js");
})();
// in the packaged app process.execPath is Electron — run the proxy as node
const AGENTS_NODE_FLAG = { ELECTRON_RUN_AS_NODE: "1" };
function agentsIntegration(botId, depth) {
    return {
        command: process.execPath,
        args: [agentsProxyPath],
        env: {
            ...AGENTS_NODE_FLAG,
            OMB_HARNESS_URL: `http://127.0.0.1:${PORT}`,
            OMB_BOT_ID: botId,
            OMB_COMMS_TOKEN: COMMS_TOKEN,
            OMB_TURN_DEPTH: String(depth),
        },
    };
}
/** Run a turn on `targetBotId` and resolve with its assistant text — the
 * synchronous half of ask_bot. Subscribes to the bus, folds assistant_text
 * for that thread, resolves on turn.completed (or a 4-min ceiling). */
function askBotAndWait(targetBotId, message, depth) {
    const target = store.bot(targetBotId);
    if (!target)
        return Promise.resolve("(no such bot)");
    const threadId = target.threadId;
    return new Promise((resolve) => {
        let text = "";
        let done = false;
        const finish = (out) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            unsub();
            resolve(out);
        };
        const unsub = bus.subscribe((e) => {
            if (e.threadId !== threadId)
                return;
            if (e.type === "item.completed" && e.itemType === "assistant_text") {
                text += (text ? "\n" : "") + e.text;
            }
            else if (e.type === "turn.completed") {
                finish(text || "(the bot finished without a text reply)");
            }
        });
        const timer = setTimeout(() => finish(text || "(timed out waiting for the bot to reply)"), 4 * 60_000);
        startTurn(targetBotId, message, { commsDepth: depth + 1 }).catch((err) => finish(`(couldn't start that bot: ${err instanceof Error ? err.message : String(err)})`));
    });
}
// default selection for new bots: first available instance, claude preferred
async function defaultSelection() {
    const described = await registry.describe();
    const available = described.filter((d) => d.snapshot.state === "available");
    const pick = available.find((d) => d.driverKind === "claudeAgent") ?? available[0] ?? described[0];
    return { instanceId: pick?.instanceId ?? "claude", model: pick?.models.default || "claude-sonnet-5" };
}
let bootSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const store = new Store(() => bootSelection);
bootSelection = await defaultSelection();
store.seedIfEmpty();
// ── SSE fan-out to clients ─────────────────────────────────────────────
const sseClients = new Set();
function broadcast(payload) {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of [...sseClients]) {
        try {
            res.write(frame);
        }
        catch {
            sseClients.delete(res);
        }
    }
}
// ── server-side event folding (upstream's ingestion worker, miniature) ──
// The canonical stream is the source of truth; the persisted transcript
// and every client view are projections of it.
const toolMessageByItem = new Map(); // itemId -> messageId
const askMessageByRequest = new Map(); // requestId -> messageId
// Group threads: the fold needs to know WHO is talking — the turn engine
// records the active member here before dispatching its turn.
const groupSpeakers = new Map();
bus.subscribe((event) => {
    broadcast({ kind: "runtime", event });
    const bot = store.botByThread(event.threadId);
    const group = bot ? undefined : store.groupByThread(event.threadId);
    if (!bot && !group)
        return;
    const speaker = group ? groupSpeakers.get(event.threadId) : undefined;
    const pushMessage = (m) => {
        const message = store.appendMessage(event.threadId, group && m.role === "bot" ? { ...m, from: speaker } : m);
        broadcast({ kind: "message", threadId: event.threadId, message });
        return message;
    };
    switch (event.type) {
        case "session.started":
            if (bot && event.sessionId && event.providerInstanceId) {
                store.setResumeCursor(bot.id, event.providerInstanceId, event.sessionId);
            }
            break;
        case "item.completed":
            if (event.itemType === "assistant_text") {
                pushMessage({ role: "bot", kind: "text", text: event.text });
            }
            else if (event.itemType === "tool" && event.itemId) {
                const messageId = toolMessageByItem.get(event.itemId);
                let toolName = "tool";
                if (messageId) {
                    toolName = store.messagesFor(event.threadId).find((m) => m.id === messageId)?.tool?.name ?? "tool";
                    const patched = store.patchMessage(event.threadId, messageId, {
                        tool: { name: toolName, ok: event.ok },
                    });
                    if (patched)
                        broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
                    toolMessageByItem.delete(event.itemId);
                }
                // the bot just acted ON ITS SCREEN — refresh the preview now. Only
                // computer tools can change the screen, and each capture competes
                // with the agent for the box's command endpoint, so a bot grinding
                // through file edits must not trigger one per tool.
                if (bot && /computer|screenshot|click|type_text|press_key|scroll|open_url/i.test(toolName)) {
                    pokeScreenPoller(bot.id);
                }
            }
            break;
        case "item.started":
            if (event.itemType === "tool") {
                // ask_bot's raw tool chip is redundant — the internal endpoint
                // appends a richer "Messaged @X" chip linking to the channel
                if (event.title?.endsWith("__ask_bot"))
                    break;
                const message = pushMessage({ role: "bot", kind: "activity", tool: { name: event.title ?? "tool" } });
                if (event.itemId)
                    toolMessageByItem.set(event.itemId, message.id);
            }
            break;
        case "request.opened": {
            const permission = event.requestType === "permission";
            const message = pushMessage({
                role: "bot",
                kind: "options",
                card: {
                    title: permission ? "Approval needed" : "Your bot has a question",
                    subtitle: event.summary,
                    options: event.choices?.length ? event.choices : permission ? ["Allow", "Deny"] : [],
                    requestId: event.requestId,
                },
            });
            if (event.requestId)
                askMessageByRequest.set(event.requestId, message.id);
            break;
        }
        case "request.resolved": {
            const messageId = event.requestId ? askMessageByRequest.get(event.requestId) : null;
            if (messageId) {
                const existing = store.messagesFor(event.threadId).find((m) => m.id === messageId);
                if (existing?.card && !existing.card.answered) {
                    const patched = store.patchMessage(event.threadId, messageId, {
                        card: { ...existing.card, answered: event.behavior, dismissed: event.source !== "user" },
                    });
                    if (patched)
                        broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
                }
                if (event.requestId)
                    askMessageByRequest.delete(event.requestId);
            }
            break;
        }
        case "runtime.error":
            pushMessage({ role: "bot", kind: "activity", tool: { name: `error: ${event.message.slice(0, 160)}`, ok: false } });
            break;
        case "turn.completed": {
            if (bot) {
                store.patchBot(bot.id, { busy: false, unread: true });
                broadcast({ kind: "bot", bot: store.bot(bot.id) });
                if (screenPollers.has(bot.id)) {
                    // the last live frame becomes a settled inline screen message —
                    // the screenshot-in-chat moment. One fresh capture first, so the
                    // frame shows the turn's END state (the final tool's poke may
                    // still be in flight).
                    void finalScreenFrame(bot.id).then((frame) => {
                        // the bot may have been deleted while the capture ran
                        if (frame && store.bot(bot.id)) {
                            pushMessage({ role: "bot", kind: "screen", png: frame.png, mime: frame.mime });
                        }
                    });
                }
            }
            // group busy/unread settle in the group turn engine, which knows
            // whether more member turns are queued behind this one
            break;
        }
    }
});
const screenPollers = new Map();
/** The preview shares the box's single command endpoint with the agent's
 * own actions, so every frame we take is latency stolen from the work the
 * user is waiting on. Hence: a slow interval, a floor between captures,
 * and never two in flight. */
const SCREEN_POLL_MS = 6000;
const SCREEN_MIN_GAP_MS = 3000;
function startScreenPoller(botId, boxId) {
    if (screenPollers.has(botId) || !box.boxConfigured(cfg))
        return;
    // One capture at a time, shared by the interval, the pokes, and the
    // turn-end grab: awaiting the in-flight promise (rather than dropping the
    // call) is what lets the final frame be the settled one. The min-gap keeps
    // a tool-heavy turn from spending the box's single command endpoint on
    // previews the user isn't waiting for.
    let current = null;
    let lastAt = 0;
    const entry = {
        timer: null,
        capture: () => {
            if (!current && Date.now() - lastAt < SCREEN_MIN_GAP_MS)
                return Promise.resolve();
            current ??= (async () => {
                try {
                    // boxId is resolved once per turn — re-resolving per frame cost a
                    // full LIST of the account's boxes
                    const { png, format } = await box.screenshotBox(cfg, botId, boxId);
                    const frame = { png, mime: format === "jpeg" ? "image/jpeg" : "image/png" };
                    entry.last = frame;
                    broadcast({ kind: "screen", botId, ...frame });
                }
                catch {
                    /* box asleep or mid-command — try again next tick */
                }
                finally {
                    lastAt = Date.now();
                    current = null;
                }
            })();
            return current;
        },
        last: null,
    };
    entry.timer = setInterval(() => void entry.capture(), SCREEN_POLL_MS);
    screenPollers.set(botId, entry);
}
/** Event-driven refresh: capture NOW (the bot just acted on its screen)
 * instead of waiting for the next interval tick. Rate-limited inside
 * capture() — a tool-heavy turn used to fire one full REST chain per
 * completed tool, competing with the agent for the same endpoint. */
function pokeScreenPoller(botId) {
    void screenPollers.get(botId)?.capture();
}
function stopScreenPoller(botId) {
    const entry = screenPollers.get(botId);
    if (!entry)
        return;
    if (entry.timer)
        clearInterval(entry.timer);
    screenPollers.delete(botId);
}
/** Turn end: stop polling, then take ONE last fresh frame (awaiting any
 * in-flight poke first) so the settled screenshot shows the screen's actual
 * end state, not the previous action's. */
async function finalScreenFrame(botId) {
    const entry = screenPollers.get(botId);
    if (!entry)
        return null;
    if (entry.timer)
        clearInterval(entry.timer);
    screenPollers.delete(botId);
    await entry.capture();
    return entry.last;
}
// Where Electron's app.getPath("userData") lands, per platform — the
// hardcoded macOS path found nothing anywhere else, and threw the
// non-ENOENT errors into the same silent catch.
// `||`, not `??`: a set-but-empty APPDATA/XDG_CONFIG_HOME would otherwise
// join into a RELATIVE path resolved against the server's cwd — the same
// silent ENOENT this function exists to stop. Electron ignores empty values
// the same way.
function userDataRoot() {
    if (process.platform === "win32")
        return process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    if (process.platform === "darwin")
        return join(homedir(), "Library", "Application Support");
    return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}
// Local computer-use contract written by Electron main on startup
// (Electron's userData dir: ~/Library/Application Support on macOS,
// %APPDATA% on Windows — <dir>/cua-connection.json). Read fresh each turn —
// Electron may restart or permissions may change.
function readCuaConnection() {
    // new name first; pre-rename desktop builds used the old directory
    for (const dir of ["OpenMausBot", "openmausbot", "OpenGrokBot", "opengrokbot"]) {
        try {
            const p = join(userDataRoot(), dir, "cua-connection.json");
            const conn = JSON.parse(readFileSync(p, "utf8"));
            if (!conn || conn.mode === "unavailable" || !conn.mcpCommand)
                continue;
            return { command: conn.mcpCommand, args: conn.mcpArgs ?? ["mcp"], env: conn.mcpEnv ?? {} };
        }
        catch {
            /* try the next location */
        }
    }
    return null;
}
// ── turn dispatch (upstream ProviderCommandReactor, miniature) ──────────
async function startTurn(botId, text, opts) {
    const bot = store.bot(botId);
    if (!bot)
        throw Object.assign(new Error("no such bot"), { status: 404 });
    if (bot.busy)
        throw Object.assign(new Error("the bot is already working — interrupt it first"), { status: 409 });
    const commsDepth = opts?.commsDepth ?? 0;
    const instance = registry.get(bot.modelSelection.instanceId);
    if (!instance) {
        throw Object.assign(new Error(`provider instance "${bot.modelSelection.instanceId}" is unavailable — pick another model in settings`), { status: 409 });
    }
    // an edit hands us its already-branched user message; a plain send appends
    let userMessage = opts?.userMessage;
    if (!userMessage) {
        userMessage = store.appendMessage(bot.threadId, { role: "user", kind: "text", text });
        broadcast({ kind: "message", threadId: bot.threadId, message: userMessage });
    }
    // transcript for API-backed drivers: settled text turns on the ACTIVE
    // branch only — abandoned forks never reach the model
    const transcript = store
        .activePath(bot.threadId)
        .filter((m) => m.kind === "text" && m.text && m.id !== userMessage.id)
        .slice(-40)
        .map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: m.text }));
    // After a rewind (edit / branch switch) the provider's native session
    // still contains the abandoned branch: start a fresh session instead of
    // resuming, and for cursor-resuming drivers replay the surviving path
    // inline (transcript-replay drivers get it via transcript). The flag is
    // cleared only once the turn is actually dispatched — clearing it here
    // would cost the next attempt its history if this dispatch fails.
    const rewound = Boolean(bot.rewound);
    const turnText = rewound && instance.driverKind !== "grok" && transcript.length
        ? [
            "[The user rewound this conversation (edited a message or switched to another version). Everything before this point was replaced by the following history:]",
            "",
            ...transcript.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`),
            "",
            "[Now reply to the user's latest message:]",
            "",
            text,
        ].join("\n")
        : text;
    const persona = [
        `You are ${bot.name}, a personal bot in OpenMausBot.`,
        bot.title && `Role: ${bot.title}.`,
        bot.description && `About: ${bot.description}`,
    ]
        .filter(Boolean)
        .join(" ");
    // busy flips immediately so the composer locks; the dispatch itself runs
    // in the background — box provisioning can take ~90s and must never
    // hang the HTTP request
    store.patchBot(bot.id, { busy: true, unread: false });
    broadcast({ kind: "bot", bot: store.bot(bot.id) });
    void (async () => {
        try {
            const integrations = {};
            if (cfg.composio?.key)
                integrations.composio = { key: cfg.composio.key, url: cfg.composio.url };
            const wants = bot.computer; // 'cloud' | 'local' | 'off' | undefined(auto)
            // only drivers that can mount the computer MCP server get the tools
            // (and the prompt about them) — but every bot with a box still gets
            // the live screen preview, which is a UI feature, not a tool
            const mountsComputer = instance.adapter.capabilities.computerMcp === true || instance.driverKind === "boxAgent";
            let previewBoxId = null;
            if (wants !== "off" && wants !== "local" && box.boxConfigured(cfg)) {
                let b = await box.findBox(cfg, bot.id).catch(() => null);
                // the Computer driver runs ON the box — provision it on first use
                if (!b && instance.driverKind === "boxAgent") {
                    broadcast({ kind: "computer", botId: bot.id, state: "provisioning" });
                    await box.provisionBox(cfg, bot.id, bot.name);
                    b = await box.findBox(cfg, bot.id).catch(() => null);
                }
                // an archived box answers every action with an error until it
                // resumes — wake it here, once, instead of letting the agent
                // discover it one failed tool call at a time. Only worth the
                // resume (~8s, and it un-pauses billing) when the bot can act.
                if (b && mountsComputer && !["idle", "ready", "running"].includes(b.state)) {
                    broadcast({ kind: "computer", botId: bot.id, state: "waking" });
                    b = (await box.readyBox(cfg, bot.id).catch(() => null)) ?? b;
                }
                if (b) {
                    previewBoxId = b.id;
                    if (mountsComputer)
                        integrations.computer = { boxId: b.id, token: cfg.box.token };
                }
            }
            // local computer (this Mac) via the Electron-hosted cua-driver: the
            // Electron main process owns the daemon (TCC attribution) and writes
            // its spawn contract to cua-connection.json; the harness only reads it
            if (!integrations.computer && wants !== "off" && wants !== "cloud") {
                const cua = readCuaConnection();
                if (cua)
                    integrations.localComputer = cua;
            }
            // peer-agent comms: give a user-initiated turn the list_bots/ask_bot
            // tools. A comms-invoked turn (depth ≥ cap) gets none — hard recursion
            // stop, so the user's tokens can't be burned by a bot-to-bot loop.
            // Only drivers that mount the tools get the integration (and, via the
            // integrations.agents gate below, the prompt hint) — a bot on a driver
            // without it must not be told about tools it cannot call. Any bot can
            // still be the TARGET of ask_bot regardless of its driver.
            if (commsDepth < MAX_COMMS_DEPTH &&
                instance.adapter.capabilities.agentsMcp === true &&
                store.bots.filter((b) => b.id !== bot.id && !b.hidden).length > 0) {
                integrations.agents = agentsIntegration(bot.id, commsDepth);
            }
            // @mentions in the user's message (the composer's tagging UI) become
            // an explicit delegation nudge — the agent still does the ask_bot call
            // itself, so the harness stays the single owner of turns/permissions
            const tagged = integrations.agents
                ? mentionedBots(text, store.bots.filter((b) => b.id !== bot.id))
                : [];
            await instance.adapter.sendTurn({
                threadId: bot.threadId,
                text: turnText,
                model: bot.modelSelection.model,
                // a rewound thread never resumes the abandoned branch's session
                resumeCursor: rewound ? undefined : bot.resumeCursors[bot.modelSelection.instanceId],
                transcript,
                system: persona +
                    (integrations.computer && instance.driverKind !== "boxAgent"
                        ? " You have your own cloud computer — use the computer tools (screenshot, click, type_text, open_url, computer_exec) whenever browsing or acting on a desktop helps. Every action tool already returns the resulting screen, so don't follow one with a screenshot call, and batch predictable sequences with computer_batch."
                        : integrations.localComputer
                            ? " You can act on the user's computer through the computer tools — take a screenshot or read the desktop state first, prefer accessibility actions over raw coordinates, and act carefully."
                            : "") +
                    (integrations.agents
                        ? " You can work with the user's other bots through the agents tools — list_bots shows who's available, ask_bot sends one of them a message and returns their reply."
                        : "") +
                    (tagged.length
                        ? ` The user tagged ${tagged
                            .map((t) => `@${t.name} (ask_bot bot_id ${t.id})`)
                            .join(" and ")} in their message — bring them in with ask_bot and fold their reply into your answer.`
                        : ""),
                integrations,
            });
            // dispatched: the rewind is spent, and the old cursors are dead
            if (rewound)
                store.patchBot(bot.id, { rewound: false, resumeCursors: {} });
            if (previewBoxId)
                startScreenPoller(bot.id, previewBoxId);
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            const failure = store.appendMessage(bot.threadId, {
                role: "bot",
                kind: "activity",
                tool: { name: `error: ${message.slice(0, 160)}`, ok: false },
            });
            broadcast({ kind: "message", threadId: bot.threadId, message: failure });
            store.patchBot(bot.id, { busy: false });
            broadcast({ kind: "bot", bot: store.bot(bot.id) });
        }
    })();
}
// ── config hot-reload ─────────────────────────────────────────────────
// ── group turn engine ──────────────────────────────────────────────────
// The Buzz rule: in a room, a bot replies only when @mentioned. Mentioned
// members run SEQUENTIALLY (one speaker at a time — the transcript and the
// streaming bubble stay coherent), each on a fresh session with the recent
// room conversation serialized into its prompt. A member's reply may
// @mention teammates; those get one chained turn (hop 1), never deeper.
const groupQueues = new Map();
const GROUP_CONTEXT_MESSAGES = 30;
const MAX_GROUP_HOPS = 1;
function serializeRoomContext(threadId, userName) {
    return store
        .messagesFor(threadId)
        .filter((m) => m.kind === "text" && m.text)
        .slice(-GROUP_CONTEXT_MESSAGES)
        .map((m) => `${m.role === "user" ? userName : (m.from?.name ?? "Bot")}: ${m.text}`)
        .join("\n");
}
function broadcastGroup(groupId) {
    const group = store.group(groupId);
    if (group)
        broadcast({ kind: "group", group });
}
async function runGroupMemberTurn(groupId, botId, hop, 
// bots that already spoke for this user message — "@Scout ask @Pixel"
// must not run Pixel twice (once chained, once as a direct responder)
spoken = new Set()) {
    const group = store.group(groupId);
    const bot = store.bot(botId);
    if (!group || !bot)
        return;
    spoken.add(botId);
    const instance = registry.get(bot.modelSelection.instanceId);
    const userName = cfg.profile?.name?.trim() || "User";
    if (!instance) {
        const failure = store.appendMessage(group.threadId, {
            role: "bot",
            kind: "activity",
            from: { botId: bot.id, name: bot.name, color: bot.color },
            tool: { name: `error: ${bot.name}'s model is unavailable`, ok: false },
        });
        broadcast({ kind: "message", threadId: group.threadId, message: failure });
        return;
    }
    store.patchGroup(group.id, { busyBotId: bot.id });
    broadcastGroup(group.id);
    groupSpeakers.set(group.threadId, { botId: bot.id, name: bot.name, color: bot.color });
    const roster = group.memberIds
        .map((id) => store.bot(id))
        .filter((b) => Boolean(b))
        .map((b) => `@${b.name}${b.title ? ` (${b.title})` : ""}`)
        .join(", ");
    const system = [
        `You are ${bot.name}, a bot in the room "${group.name}" in OpenMausBot.`,
        bot.title && `Role: ${bot.title}.`,
        bot.description && `About: ${bot.description}`,
        `Room members: ${roster}, and ${userName} (the human).`,
        group.bulletin.trim() && `Room bulletin (shared instructions for everyone):\n${group.bulletin.trim()}`,
        `Reply as yourself, briefly and conversationally. To bring a teammate in, mention them like @Name — they'll see the conversation and respond.`,
    ]
        .filter(Boolean)
        .join("\n");
    const text = `${serializeRoomContext(group.threadId, userName)}\n\n(Reply to the conversation above as ${bot.name}.)`;
    // run the turn and wait for it to settle, folding the reply text so a
    // chained @mention can be routed afterwards
    let replyText = "";
    await new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            unsub();
            resolve();
        };
        const unsub = bus.subscribe((e) => {
            if (e.threadId !== group.threadId)
                return;
            if (e.type === "item.completed" && e.itemType === "assistant_text")
                replyText += `\n${e.text}`;
            else if (e.type === "turn.completed")
                finish();
        });
        const timer = setTimeout(finish, 5 * 60_000);
        instance.adapter
            .sendTurn({ threadId: group.threadId, text, system })
            .catch((err) => {
            const failure = store.appendMessage(group.threadId, {
                role: "bot",
                kind: "activity",
                from: { botId: bot.id, name: bot.name, color: bot.color },
                tool: { name: `error: ${err instanceof Error ? err.message.slice(0, 140) : "turn failed"}`, ok: false },
            });
            broadcast({ kind: "message", threadId: group.threadId, message: failure });
            finish();
        });
    });
    groupSpeakers.delete(group.threadId);
    store.patchGroup(group.id, { busyBotId: null, unread: true });
    broadcastGroup(group.id);
    // chained mentions: a member's reply can summon teammates — one hop only
    if (hop < MAX_GROUP_HOPS && replyText.trim()) {
        const members = group.memberIds
            .map((id) => store.bot(id))
            .filter((b) => Boolean(b) && b.id !== bot.id);
        for (const next of mentionedBots(replyText, members)) {
            if (spoken.has(next.id))
                continue;
            await runGroupMemberTurn(groupId, next.id, hop + 1, spoken);
        }
    }
}
function startGroupTurn(groupId, text) {
    const group = store.group(groupId);
    if (!group)
        throw Object.assign(new Error("no such group"), { status: 404 });
    const userMessage = store.appendMessage(group.threadId, { role: "user", kind: "text", text });
    broadcast({ kind: "message", threadId: group.threadId, message: userMessage });
    const members = group.memberIds
        .map((id) => store.bot(id))
        .filter((b) => Boolean(b));
    const mentioned = mentionedBots(text, members);
    // Buzz rule: nobody replies unless mentioned — except a one-member room,
    // where the single bot obviously IS the addressee
    let responders = mentioned.length ? mentioned : members.length === 1 ? members : [];
    // bot⇄bot channels: chipping in without a tag addresses the last speaker
    if (!responders.length && group.dm) {
        const lastSpeakerId = [...store.messagesFor(group.threadId)]
            .reverse()
            .find((msg) => msg.kind === "text" && msg.from)?.from?.botId;
        const last = members.find((b) => b.id === lastSpeakerId) ?? members[0];
        responders = last ? [last] : [];
    }
    if (!responders.length)
        return;
    const prev = groupQueues.get(groupId) ?? Promise.resolve();
    const next = prev.then(async () => {
        const spoken = new Set();
        for (const responder of responders) {
            if (spoken.has(responder.id))
                continue;
            await runGroupMemberTurn(groupId, responder.id, 0, spoken);
        }
    });
    groupQueues.set(groupId, next.catch(() => { }));
}
function configStatus() {
    return {
        xai: { configured: Boolean(cfg.xai?.key) },
        composio: { configured: Boolean(cfg.composio?.key), apiKeyConfigured: Boolean(cfg.composio?.apiKey) },
        box: { configured: Boolean(cfg.box?.token) },
        // not a secret — the sidebar shows it
        profile: { name: cfg.profile?.name ?? "", email: cfg.profile?.email ?? "" },
    };
}
/** Rebuild the provider fleet after a config change so new keys take
 * effect without a server restart (kills any in-flight turns). */
async function reloadProviders() {
    bus.detachAll();
    await registry.disposeAll();
    await registry.load(instanceConfigs(cfg));
    bus.attach(registry.instances());
    // A killed turn's terminal events can die with the old fleet (dispose is
    // async under the hood), stranding the bot busy — and its screen poller —
    // forever. Settle anything still marked busy.
    for (const b of store.bots.filter((b) => b.busy)) {
        stopScreenPoller(b.id);
        const note = store.appendMessage(b.threadId, {
            role: "bot",
            kind: "activity",
            tool: { name: "error: turn interrupted — provider settings changed", ok: false },
        });
        broadcast({ kind: "message", threadId: b.threadId, message: note });
        store.patchBot(b.id, { busy: false });
        broadcast({ kind: "bot", bot: store.bot(b.id) });
    }
}
// ── HTTP plumbing ─────────────────────────────────────────────────────
function json(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(data);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (c) => {
            data += c;
            if (data.length > 1_000_000)
                reject(new Error("body too large"));
        });
        req.on("end", () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            }
            catch {
                reject(new Error("invalid JSON body"));
            }
        });
        req.on("error", reject);
    });
}
const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
        // ── internal peer-agent comms (localhost + shared token only) ──────
        // The agents-proxy (spawned inside a bot's agent process) calls these to
        // discover peers and hand a message to one. Not part of the public API.
        if (path.startsWith("/api/internal/")) {
            if (req.headers.authorization !== `Bearer ${COMMS_TOKEN}`) {
                return json(res, 401, { error: "unauthorized" });
            }
            if (method === "GET" && path === "/api/internal/agents") {
                const self = url.searchParams.get("self");
                // title/description included so a "chief of staff"-style bot can
                // judge the team (who does what, who has no job description yet)
                const bots = store.bots
                    .filter((b) => b.id !== self && !b.hidden)
                    .map((b) => ({
                    id: b.id,
                    name: b.name,
                    model: b.modelSelection.model,
                    busy: !!b.busy,
                    title: b.title || undefined,
                    description: b.description || undefined,
                }));
                return json(res, 200, { bots });
            }
            if (method === "POST" && path === "/api/internal/ask-bot") {
                const body = await readBody(req);
                const fromBotId = String(body.fromBotId ?? "");
                const toBotId = String(body.toBotId ?? "");
                const message = String(body.message ?? "").trim();
                const depth = Number(body.depth ?? 0) || 0;
                if (!toBotId || !message)
                    return json(res, 400, { error: "toBotId and message required" });
                if (toBotId === fromBotId)
                    return json(res, 400, { error: "a bot cannot message itself" });
                if (depth >= MAX_COMMS_DEPTH)
                    return json(res, 200, { error: "message chains are limited to one hop" });
                const target = store.bot(toBotId);
                if (!target)
                    return json(res, 404, { error: "no such bot" });
                if (target.busy)
                    return json(res, 200, { busy: true });
                const from = store.bot(fromBotId);
                const fromName = from?.name ?? "another bot";
                // the exchange is mirrored into a bot⇄bot channel: it shows up in
                // the sidebar like any room, keeps the pair's full history, and the
                // user can open it and chip in
                let channel = from ? store.dmGroup(from.id, target.id) : undefined;
                if (from && !channel) {
                    channel = store.createGroup(`${from.name} ⇄ ${target.name}`, [from.id, target.id], true);
                }
                const mirror = (speaker, text) => {
                    if (!channel || !text.trim())
                        return;
                    const msg = store.appendMessage(channel.threadId, {
                        role: "bot",
                        kind: "text",
                        text,
                        from: { botId: speaker.id, name: speaker.name, color: speaker.color },
                    });
                    broadcast({ kind: "message", threadId: channel.threadId, message: msg });
                };
                // both 1:1 threads get a clickable chip that opens the channel, so
                // bot-to-bot turns are never invisible (they cost the user tokens)
                const chip = (threadId, label, withBot) => {
                    const note = store.appendMessage(threadId, {
                        role: "bot",
                        kind: "activity",
                        tool: { name: label },
                        comm: channel
                            ? { groupId: channel.id, withBotId: withBot.id, withName: withBot.name, withColor: withBot.color }
                            : undefined,
                    });
                    broadcast({ kind: "message", threadId, message: note });
                };
                if (from) {
                    mirror(from, message);
                    chip(from.threadId, `Messaged @${target.name}`, target);
                    chip(target.threadId, `Message from @${from.name}`, from);
                    if (channel) {
                        store.patchGroup(channel.id, { unread: true });
                        broadcastGroup(channel.id);
                    }
                }
                const prefixed = `[Message from @${fromName}, another bot in this OpenMausBot workspace. Reply to them.]\n\n${message}`;
                const reply = await askBotAndWait(toBotId, prefixed, depth);
                if (from) {
                    mirror(target, reply);
                    if (channel) {
                        store.patchGroup(channel.id, { unread: true });
                        broadcastGroup(channel.id);
                    }
                }
                return json(res, 200, { botName: target.name, text: reply });
            }
            return json(res, 404, { error: "unknown internal endpoint" });
        }
        // ── events stream ──
        if (method === "GET" && path === "/api/events") {
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            res.write(`data: ${JSON.stringify({ kind: "hello" })}\n\n`);
            sseClients.add(res);
            const keepalive = setInterval(() => {
                try {
                    res.write(": keepalive\n\n");
                }
                catch { }
            }, 25_000);
            req.on("close", () => {
                clearInterval(keepalive);
                sseClients.delete(res);
            });
            return;
        }
        // ── bots ──
        if (method === "GET" && path === "/api/bots") {
            return json(res, 200, {
                bots: store.bots.map((b) => ({
                    ...b,
                    messages: store.messagesFor(b.threadId),
                    activeLeafId: store.activeLeaf(b.threadId),
                })),
                groups: store.groups.map((g) => ({ ...g, messages: store.messagesFor(g.threadId) })),
            });
        }
        // ── rooms (group chats) ─────────────────────────────────────────────
        let m = null;
        if (method === "POST" && path === "/api/groups") {
            const body = await readBody(req);
            const memberIds = (Array.isArray(body.memberIds) ? body.memberIds : []).filter((id) => typeof id === "string" && Boolean(store.bot(id)));
            if (memberIds.length === 0)
                return json(res, 400, { error: "a room needs at least one bot" });
            const name = typeof body.name === "string" && body.name.trim()
                ? body.name.trim()
                : `${store.bot(memberIds[0]).name} & co.`;
            const group = store.createGroup(name, memberIds);
            broadcast({ kind: "group", group });
            return json(res, 201, { group: { ...group, messages: [] } });
        }
        m = path.match(/^\/api\/groups\/([\w-]+)$/);
        if (m && method === "PATCH") {
            const body = await readBody(req);
            const patch = {};
            for (const key of ["name", "bulletin", "unread"]) {
                if (body[key] !== undefined)
                    patch[key] = body[key];
            }
            if (Array.isArray(body.memberIds)) {
                const ids = body.memberIds.filter((id) => typeof id === "string" && Boolean(store.bot(id)));
                if (ids.length)
                    patch.memberIds = ids;
            }
            const group = store.patchGroup(m[1], patch);
            if (!group)
                return json(res, 404, { error: "no such room" });
            broadcast({ kind: "group", group });
            return json(res, 200, { group });
        }
        m = path.match(/^\/api\/groups\/([\w-]+)$/);
        if (m && method === "DELETE") {
            const group = store.group(m[1]);
            if (!group)
                return json(res, 404, { error: "no such room" });
            store.deleteGroup(group.id);
            for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
                try {
                    unlinkSync(join(dir, `${group.threadId}.ndjson`));
                }
                catch { }
            }
            broadcast({ kind: "group.deleted", groupId: group.id });
            return json(res, 200, { ok: true });
        }
        m = path.match(/^\/api\/groups\/([\w-]+)\/messages$/);
        if (m && method === "POST") {
            const body = await readBody(req);
            const text = String(body.text ?? "").trim();
            if (!text)
                return json(res, 400, { error: "text required" });
            startGroupTurn(m[1], text);
            return json(res, 202, { ok: true });
        }
        m = path.match(/^\/api\/groups\/([\w-]+)\/interrupt$/);
        if (m && method === "POST") {
            const group = store.group(m[1]);
            if (!group)
                return json(res, 404, { error: "no such room" });
            const busy = group.busyBotId ? store.bot(group.busyBotId) : undefined;
            const instance = busy ? registry.get(busy.modelSelection.instanceId) : undefined;
            await instance?.adapter.interruptTurn(group.threadId).catch(() => { });
            return json(res, 200, { ok: true });
        }
        // emoji reactions — works on any thread (1:1 or room)
        m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/reactions$/);
        if (m && method === "POST") {
            const body = await readBody(req);
            const emoji = String(body.emoji ?? "").slice(0, 8);
            if (!emoji)
                return json(res, 400, { error: "emoji required" });
            const patched = store.toggleReaction(m[1], m[2], emoji, typeof body.by === "string" ? body.by : "user");
            if (!patched)
                return json(res, 404, { error: "no such message" });
            broadcast({ kind: "message.patch", threadId: m[1], message: patched });
            return json(res, 200, { message: patched });
        }
        if (method === "POST" && path === "/api/bots") {
            const bot = store.createBot();
            store.patchBot(bot.id, { modelSelection: await defaultSelection() });
            return json(res, 201, {
                bot: {
                    ...store.bot(bot.id),
                    messages: store.messagesFor(bot.threadId),
                    activeLeafId: store.activeLeaf(bot.threadId),
                },
            });
        }
        m = path.match(/^\/api\/bots\/([\w-]+)$/);
        if (m && method === "PATCH") {
            const body = await readBody(req);
            const patch = {};
            for (const key of ["name", "title", "description", "notifications", "modelSelection", "unread", "computer", "color", "mascotExpression", "pinned", "hidden"]) {
                if (body[key] !== undefined)
                    patch[key] = body[key];
            }
            const bot = store.patchBot(m[1], patch);
            if (!bot)
                return json(res, 404, { error: "no such bot" });
            broadcast({ kind: "bot", bot });
            return json(res, 200, { bot });
        }
        m = path.match(/^\/api\/bots\/([\w-]+)$/);
        if (m && method === "DELETE") {
            const bot = store.bot(m[1]);
            if (!bot)
                return json(res, 404, { error: "no such bot" });
            // a running turn dies with its bot
            await registry.get(bot.modelSelection.instanceId)?.adapter.interruptTurn(bot.threadId).catch(() => { });
            stopScreenPoller(bot.id);
            store.deleteBot(bot.id);
            for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
                try {
                    unlinkSync(join(dir, `${bot.threadId}.ndjson`));
                }
                catch { }
            }
            broadcast({ kind: "bot.deleted", botId: bot.id });
            return json(res, 200, { ok: true });
        }
        // onboarding/ask cards persist their answered/dismissed state
        m = path.match(/^\/api\/bots\/([\w-]+)\/cards\/([\w-]+)$/);
        if (m && method === "PATCH") {
            const bot = store.bot(m[1]);
            if (!bot)
                return json(res, 404, { error: "no such bot" });
            const existing = store.messagesFor(bot.threadId).find((msg) => msg.id === m[2]);
            if (!existing?.card)
                return json(res, 404, { error: "no such card" });
            const body = await readBody(req);
            const patched = store.patchMessage(bot.threadId, m[2], {
                card: {
                    ...existing.card,
                    ...(body.answered !== undefined ? { answered: body.answered } : {}),
                    ...(body.dismissed !== undefined ? { dismissed: body.dismissed } : {}),
                },
            });
            broadcast({ kind: "message.patch", threadId: bot.threadId, message: patched });
            return json(res, 200, { message: patched });
        }
        m = path.match(/^\/api\/bots\/([\w-]+)\/messages$/);
        if (m && method === "POST") {
            const body = await readBody(req);
            const text = String(body.text ?? "").trim();
            if (!text)
                return json(res, 400, { error: "text required" });
            await startTurn(m[1], text);
            return json(res, 202, { ok: true });
        }
        // edit a user message → fork the conversation there and rerun the turn.
        // Rewinding a live thread is refused, exactly like switching versions
        // below: interrupting mid-flight and branching under the dying turn is
        // how a conversation ends up with two tails. Stop, then edit.
        m = path.match(/^\/api\/bots\/([\w-]+)\/messages\/([\w-]+)\/edit$/);
        if (m && method === "POST") {
            const messageId = m[2];
            const bot = store.bot(m[1]);
            if (!bot)
                return json(res, 404, { error: "no such bot" });
            const body = await readBody(req);
            const text = String(body.text ?? "").trim();
            if (!text)
                return json(res, 400, { error: "text required" });
            // everything from here down is synchronous, so two racing edits can
            // never both get past this check: startTurn flips busy before the
            // next request is handled
            if (bot.busy)
                return json(res, 409, { error: "the bot is working — stop it before editing" });
            const source = store.messagesFor(bot.threadId).find((msg) => msg.id === messageId);
            if (!source || source.role !== "user" || source.kind !== "text") {
                return json(res, 404, { error: "only user messages can be edited" });
            }
            if (!registry.get(bot.modelSelection.instanceId)) {
                return json(res, 409, {
                    error: `provider instance "${bot.modelSelection.instanceId}" is unavailable — pick another model in settings`,
                });
            }
            const message = store.branchMessage(bot.threadId, messageId, text);
            if (!message)
                return json(res, 404, { error: "no such message" });
            store.patchBot(bot.id, { rewound: true });
            broadcast({ kind: "message", threadId: bot.threadId, message });
            broadcast({ kind: "thread", threadId: bot.threadId, activeLeafId: message.id });
            await startTurn(bot.id, text, { userMessage: message });
            return json(res, 202, { ok: true });
        }
        // switch which fork of the conversation is visible (no new turn)
        m = path.match(/^\/api\/bots\/([\w-]+)\/active-branch$/);
        if (m && method === "POST") {
            const bot = store.bot(m[1]);
            if (!bot)
                return json(res, 404, { error: "no such bot" });
            if (bot.busy)
                return json(res, 409, { error: "the bot is working — stop it before switching versions" });
            const body = await readBody(req);
            const leaf = store.setActiveLeaf(bot.threadId, String(body.messageId ?? ""));
            if (!leaf)
                return json(res, 404, { error: "no such message" });
            // provider sessions still hold the other branch — next turn replays
            store.patchBot(bot.id, { rewound: true });
            broadcast({ kind: "thread", threadId: bot.threadId, activeLeafId: leaf });
            return json(res, 200, { activeLeafId: leaf });
        }
        m = path.match(/^\/api\/bots\/([\w-]+)\/respond$/);
        if (m && method === "POST") {
            const bot = store.bot(m[1]);
            if (!bot)
                return json(res, 404, { error: "no such bot" });
            const body = await readBody(req);
            const instance = registry.get(bot.modelSelection.instanceId);
            if (!instance)
                return json(res, 409, { error: "provider unavailable" });
            await instance.adapter.respondToRequest(bot.threadId, String(body.requestId), {
                behavior: body.behavior,
                message: body.message,
            });
            return json(res, 200, { ok: true });
        }
        m = path.match(/^\/api\/bots\/([\w-]+)\/interrupt$/);
        if (m && method === "POST") {
            const bot = store.bot(m[1]);
            if (!bot)
                return json(res, 404, { error: "no such bot" });
            const instance = registry.get(bot.modelSelection.instanceId);
            await instance?.adapter.interruptTurn(bot.threadId);
            return json(res, 200, { ok: true });
        }
        // identity handshake for the packaged app's port fallback: the forked
        // child proves it is OURS by echoing its pid (a stray dev server has
        // the same API shape but a different pid)
        if (method === "GET" && path === "/api/health") {
            return json(res, 200, { app: "openmausbot", pid: process.pid, static: Boolean(STATIC_DIR) });
        }
        // ── provider instances (model picker) ──
        if (method === "GET" && path === "/api/instances") {
            return json(res, 200, { instances: await registry.describe() });
        }
        // ── app config (API keys — never echoed back, booleans only) ──
        if (method === "GET" && path === "/api/config") {
            return json(res, 200, configStatus());
        }
        if ((method === "PUT" || method === "PATCH") && path === "/api/config") {
            const body = await readBody(req);
            const patch = {};
            for (const key of ["xai", "composio", "box", "profile"]) {
                if (body[key] && typeof body[key] === "object")
                    patch[key] = body[key];
            }
            if (!Object.keys(patch).length)
                return json(res, 400, { error: "nothing to save" });
            saveConfig(patch);
            Object.assign(cfg, loadConfig());
            // provider keys change the fleet; a profile edit must not kill
            // in-flight turns with a pointless reload
            if (Object.keys(patch).some((k) => k !== "profile"))
                await reloadProviders();
            const status = configStatus();
            broadcast({ kind: "config", ...status });
            return json(res, 200, status);
        }
        // ── connectors (Composio) ──
        if (method === "GET" && path === "/api/connectors/catalog") {
            const { cards, source } = await composio.listToolkits(cfg);
            return json(res, 200, { configured: Boolean(cfg.composio?.key), source, cards });
        }
        if (method === "GET" && path === "/api/connectors") {
            const services = (url.searchParams.get("services") ?? "").split(",").filter(Boolean);
            if (!cfg.composio?.key)
                return json(res, 200, { configured: false, services: {} });
            const status = await composio.connectionStatus(cfg, services.length ? services : composio.CURATED_SLUGS);
            return json(res, 200, { configured: true, services: status });
        }
        m = path.match(/^\/api\/connectors\/([\w-]+)\/authorize$/);
        if (m && method === "POST")
            return json(res, 200, await composio.authorizeService(cfg, m[1]));
        m = path.match(/^\/api\/connectors\/([\w-]+)$/);
        if (m && method === "DELETE")
            return json(res, 200, await composio.removeService(cfg, m[1]));
        // ── the bot's cloud computer (Box) ──
        m = path.match(/^\/api\/bots\/([\w-]+)\/computer$/);
        if (m && method === "GET")
            return json(res, 200, await box.boxStatus(cfg, m[1]));
        m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/(provision|join|sleep|exec|screenshot)$/);
        if (m && method === "POST") {
            const botId = m[1];
            const bot = store.bot(botId);
            if (!bot)
                return json(res, 404, { error: "no such bot" });
            switch (m[2]) {
                case "provision":
                    return json(res, 200, await box.provisionBox(cfg, botId, bot.name));
                case "join":
                    return json(res, 200, await box.joinBox(cfg, botId));
                case "sleep":
                    return json(res, 200, await box.sleepBox(cfg, botId));
                case "exec": {
                    const body = await readBody(req);
                    return json(res, 200, await box.execOnBox(cfg, botId, String(body.command ?? "")));
                }
                case "screenshot":
                    return json(res, 200, await box.screenshotBox(cfg, botId));
            }
        }
        // packaged app: the server serves the built UI too (window → :8799 for
        // everything, no dev proxy to die). OMB_STATIC_DIR is set by Electron.
        if (method === "GET" && !path.startsWith("/api/") && STATIC_DIR) {
            const safe = path === "/" ? "/index.html" : path.replace(/\.\./g, "");
            const file = join(STATIC_DIR, safe);
            try {
                const data = readFileSync(file);
                res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
                return res.end(data);
            }
            catch {
                // SPA fallback
                try {
                    const data = readFileSync(join(STATIC_DIR, "index.html"));
                    res.writeHead(200, { "content-type": "text/html" });
                    return res.end(data);
                }
                catch {
                    /* fall through to 404 */
                }
            }
        }
        return json(res, 404, { error: `no route: ${method} ${path}` });
    }
    catch (e) {
        const status = e?.status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
});
server.listen(PORT, "127.0.0.1", () => {
    console.log(`openmausbot server on http://127.0.0.1:${PORT}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        void registry.disposeAll().finally(() => process.exit(0));
    });
}
