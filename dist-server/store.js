// Bot + thread persistence. bots.json holds bot records (including the
// thread→instance binding and per-instance resume cursors — upstream's
// ProviderSessionDirectory, recipe step 6: persist the binding from day
// one). messages-<threadId>.json holds the folded transcript.
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { newId } from "./contracts.js";
import { pickBotName } from "./names.js";
const BOTS_FILE = join(DATA_DIR, "bots.json");
const GROUPS_FILE = join(DATA_DIR, "groups.json");
const messagesFile = (threadId) => join(DATA_DIR, `messages-${threadId}.json`);
const COLORS = [
    "green",
    "blue",
    "red",
    "orange",
    "purple",
    "cyan",
    "pink",
    "yellow",
    "teal",
    "coral",
];
/** Resolve @mentions in a message against a bot roster: `@` must start a
 * word, names match case-insensitively, longest name wins (so "@New Bot 2"
 * never half-matches "New Bot"), hidden bots skipped, results deduped.
 * Callers pre-filter the sender out of `peers`. */
export function mentionedBots(text, peers) {
    const candidates = peers
        .filter((p) => !p.hidden && p.name.trim())
        .sort((a, b) => b.name.length - a.name.length);
    const lower = text.toLowerCase();
    const found = [];
    let at = -1;
    while ((at = lower.indexOf("@", at + 1)) !== -1) {
        if (at > 0 && !/\s/.test(text[at - 1]))
            continue; // user@host, not a tag
        const rest = lower.slice(at + 1);
        const hit = candidates.find((p) => rest.startsWith(p.name.toLowerCase()));
        if (hit && !found.includes(hit))
            found.push(hit);
    }
    return found;
}
const onboardingCard = () => ({
    title: "What do you mostly want help with?",
    subtitle: "Pick whatever's closest; we can always expand from there.",
    options: ["Work & projects", "Writing & research", "Life admin", "A bit of everything"],
});
export class Store {
    bots = [];
    groups = [];
    threads = new Map();
    defaultSelection;
    constructor(defaultSelection) {
        this.defaultSelection = defaultSelection;
        mkdirSync(DATA_DIR, { recursive: true });
        try {
            this.bots = JSON.parse(readFileSync(BOTS_FILE, "utf8"));
        }
        catch {
            this.bots = [];
        }
        try {
            this.groups = JSON.parse(readFileSync(GROUPS_FILE, "utf8"));
        }
        catch {
            this.groups = [];
        }
        // busy never survives a restart — no turn does either
        for (const b of this.bots)
            b.busy = false;
        for (const g of this.groups)
            g.busyBotId = null;
    }
    saveBots() {
        writeFileSync(BOTS_FILE, JSON.stringify(this.bots, null, 2));
    }
    saveGroups() {
        writeFileSync(GROUPS_FILE, JSON.stringify(this.groups.map(({ busyBotId, ...g }) => g), null, 2));
    }
    // ── groups ────────────────────────────────────────────────────────────
    group(id) {
        return this.groups.find((g) => g.id === id);
    }
    groupByThread(threadId) {
        return this.groups.find((g) => g.threadId === threadId);
    }
    createGroup(name, memberIds, dm = false) {
        const group = {
            id: newId(),
            threadId: newId(),
            name,
            memberIds,
            bulletin: "",
            unread: false,
            createdAt: Date.now(),
            dm: dm || undefined,
            busyBotId: null,
        };
        this.groups.unshift(group);
        this.saveGroups();
        return group;
    }
    /** The bot⇄bot channel for a pair, if it exists (order-insensitive). */
    dmGroup(a, b) {
        return this.groups.find((g) => g.dm && g.memberIds.length === 2 && g.memberIds.includes(a) && g.memberIds.includes(b));
    }
    patchGroup(id, patch) {
        const group = this.group(id);
        if (!group)
            return null;
        Object.assign(group, patch);
        this.saveGroups();
        return group;
    }
    deleteGroup(id) {
        const group = this.group(id);
        if (!group)
            return false;
        this.groups = this.groups.filter((g) => g.id !== id);
        this.threads.delete(group.threadId);
        this.saveGroups();
        try {
            unlinkSync(messagesFile(group.threadId));
        }
        catch { }
        return true;
    }
    /** Toggle an emoji reaction on a message ("user" or a member botId). */
    toggleReaction(threadId, messageId, emoji, by) {
        const existing = this.messagesFor(threadId).find((m) => m.id === messageId);
        if (!existing)
            return null;
        const reactions = existing.reactions ?? [];
        const at = reactions.findIndex((r) => r.emoji === emoji && r.by === by);
        const next = at >= 0 ? reactions.filter((_, i) => i !== at) : [...reactions, { emoji, by }];
        return this.patchMessage(threadId, messageId, { reactions: next.length ? next : undefined });
    }
    thread(threadId) {
        let t = this.threads.get(threadId);
        if (t)
            return t;
        let messages = [];
        let activeLeafId = null;
        try {
            const raw = JSON.parse(readFileSync(messagesFile(threadId), "utf8"));
            if (Array.isArray(raw))
                messages = raw; // pre-branching flat file
            else {
                messages = raw.messages ?? [];
                activeLeafId = raw.activeLeafId ?? null;
            }
        }
        catch {
            /* fresh thread */
        }
        // legacy rows carry no parentId — chain them in array order
        let prev = null;
        for (const m of messages) {
            if (m.parentId === undefined)
                m.parentId = prev;
            prev = m.id;
        }
        if (!activeLeafId)
            activeLeafId = messages.at(-1)?.id ?? null;
        t = { messages, activeLeafId };
        this.threads.set(threadId, t);
        return t;
    }
    saveThread(threadId) {
        const t = this.thread(threadId);
        writeFileSync(messagesFile(threadId), JSON.stringify({ activeLeafId: t.activeLeafId, messages: t.messages }, null, 2));
    }
    messagesFor(threadId) {
        return this.thread(threadId).messages;
    }
    activeLeaf(threadId) {
        return this.thread(threadId).activeLeafId;
    }
    /** The visible conversation: root → activeLeafId. */
    activePath(threadId) {
        const t = this.thread(threadId);
        const byId = new Map(t.messages.map((m) => [m.id, m]));
        const path = [];
        let cur = t.activeLeafId ? byId.get(t.activeLeafId) : undefined;
        while (cur) {
            path.push(cur);
            cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
        return path.reverse();
    }
    appendMessage(threadId, message) {
        const t = this.thread(threadId);
        const full = { id: newId(), at: Date.now(), parentId: t.activeLeafId, ...message };
        t.messages.push(full);
        t.activeLeafId = full.id;
        if (full.kind === "screen")
            this.pruneScreenFrames(t);
        this.saveThread(threadId);
        return full;
    }
    /** Screen frames are ~100-500KB of base64 each and the whole thread file
     * is rewritten on every append, so keeping every frame of a long
     * computer session makes each later message slower than the last. The
     * newest few keep their pixels; older ones stay in the transcript as
     * placeholders. Mirrors the client's own frame cap. */
    pruneScreenFrames(t, keep = 4) {
        let seen = 0;
        for (let i = t.messages.length - 1; i >= 0 && seen < t.messages.length; i--) {
            const m = t.messages[i];
            if (m.kind !== "screen" || !m.png)
                continue;
            seen += 1;
            if (seen > keep)
                m.png = undefined;
        }
    }
    /** Fork the conversation: a new user message that replaces `sourceId`
     * (same parent, new text) and becomes the active leaf. */
    branchMessage(threadId, sourceId, text) {
        const t = this.thread(threadId);
        const source = t.messages.find((m) => m.id === sourceId);
        if (!source)
            return null;
        const full = {
            id: newId(),
            at: Date.now(),
            role: "user",
            kind: "text",
            text,
            parentId: source.parentId ?? null,
        };
        t.messages.push(full);
        t.activeLeafId = full.id;
        this.saveThread(threadId);
        return full;
    }
    /** Point the visible conversation at the branch containing `messageId`,
     * descending to that branch's most recently active leaf. */
    setActiveLeaf(threadId, messageId) {
        const t = this.thread(threadId);
        if (!t.messages.some((m) => m.id === messageId))
            return null;
        let cur = messageId;
        for (;;) {
            const children = t.messages.filter((m) => m.parentId === cur);
            if (!children.length)
                break;
            cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
        }
        t.activeLeafId = cur;
        this.saveThread(threadId);
        return cur;
    }
    patchMessage(threadId, messageId, patch) {
        const t = this.thread(threadId);
        const idx = t.messages.findIndex((m) => m.id === messageId);
        if (idx === -1)
            return null;
        t.messages[idx] = { ...t.messages[idx], ...patch, card: patch.card ?? t.messages[idx].card };
        this.saveThread(threadId);
        return t.messages[idx];
    }
    bot(id) {
        return this.bots.find((b) => b.id === id) ?? null;
    }
    botByThread(threadId) {
        return this.bots.find((b) => b.threadId === threadId) ?? null;
    }
    createBot() {
        const name = pickBotName(this.bots.map((b) => b.name));
        const bot = {
            id: newId(),
            threadId: newId(),
            name,
            title: "",
            description: "",
            notifications: true,
            color: COLORS[this.bots.length % COLORS.length],
            unread: false,
            modelSelection: this.defaultSelection(),
            resumeCursors: {},
            createdAt: Date.now(),
        };
        this.bots.unshift(bot);
        this.saveBots();
        this.appendMessage(bot.threadId, {
            role: "bot",
            kind: "text",
            text: `Hey — I'm ${name}. Nice to meet you.`,
        });
        this.appendMessage(bot.threadId, { role: "bot", kind: "options", card: onboardingCard() });
        return bot;
    }
    deleteBot(id) {
        const bot = this.bot(id);
        if (!bot)
            return false;
        this.bots = this.bots.filter((b) => b.id !== id);
        this.threads.delete(bot.threadId);
        this.saveBots();
        try {
            unlinkSync(messagesFile(bot.threadId));
        }
        catch { }
        return true;
    }
    patchBot(id, patch) {
        const bot = this.bot(id);
        if (!bot)
            return null;
        Object.assign(bot, patch);
        this.saveBots();
        return bot;
    }
    setResumeCursor(botId, instanceId, cursor) {
        const bot = this.bot(botId);
        if (!bot)
            return;
        bot.resumeCursors[instanceId] = cursor;
        this.saveBots();
    }
    /** First-run seed: one bot so the app never opens empty — it gets a
     * random friendly name like every other bot. */
    seedIfEmpty() {
        if (this.bots.length)
            return;
        this.createBot();
    }
}
