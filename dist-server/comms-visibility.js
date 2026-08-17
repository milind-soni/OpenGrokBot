// Bot⇄bot comms visibility: channel creation, message mirroring, and
// per-thread chips. Extracted from /api/internal/ask-bot so delegations
// (delegate_bot) and any future peer flow reuse the same UX without a copy.
/** Find or create the bot⇄bot channel for the pair. The channel keeps
 * the pair's full exchange, lives in the sidebar like any room, and the
 * user can open it to chip in. */
export function getOrCreateChannel(store, from, target) {
    return (store.dmGroup(from.id, target.id) ??
        store.createGroup(`${from.name} ⇄ ${target.name}`, [from.id, target.id], true));
}
/** Mirror `from`'s outgoing message into the channel, drop chips into
 * both 1:1 threads linking to the channel, and bump the channel's unread
 * count. The chips are what make bot-to-bot turns observable — those
 * turns cost the user tokens, and a hidden exchange is exactly the kind
 * of mistake peer coordination is supposed to avoid. */
export function mirrorExchange(bus, from, target, message, channel, sourceThreadId = from.threadId) {
    const note = (threadId, m) => {
        const message = bus.store.appendMessage(threadId, m);
        bus.broadcast({ kind: "message", threadId, message });
        return message;
    };
    if (channel) {
        note(channel.threadId, {
            role: "bot",
            kind: "text",
            text: message,
            from: { botId: from.id, name: from.name, color: from.color },
        });
    }
    note(sourceThreadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Messaged @${target.name}` },
        comm: channel
            ? { groupId: channel.id, withBotId: target.id, withName: target.name, withColor: target.color }
            : undefined,
    });
    note(target.threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Message from @${from.name}` },
        comm: channel
            ? { groupId: channel.id, withBotId: from.id, withName: from.name, withColor: from.color }
            : undefined,
    });
    if (channel) {
        bus.store.patchGroup(channel.id, { unread: true });
        bus.broadcastGroup(channel.id);
    }
}
/** Mirror `target`'s reply into the channel so the channel stays the
 * single authoritative record of the exchange. The 1:1 threads already
 * carry their own chips from `mirrorExchange`. */
export function mirrorReply(bus, target, reply, channel) {
    if (!channel || !reply.trim())
        return;
    const message = bus.store.appendMessage(channel.threadId, {
        role: "bot",
        kind: "text",
        text: reply,
        from: { botId: target.id, name: target.name, color: target.color },
    });
    bus.broadcast({ kind: "message", threadId: channel.threadId, message });
    bus.store.patchGroup(channel.id, { unread: true });
    bus.broadcastGroup(channel.id);
}
/** Mirror a terminal activity note into the channel — for async handoffs
 * whose terminal state is not a reply (turn failed, was stopped, or never
 * started). Prior art (A2A, MCP Tasks) is unanimous that every terminal
 * state of an async handoff should be visible where the human is looking,
 * and the channel is that place. */
export function mirrorActivity(bus, from, channel, name, ok) {
    if (!channel)
        return;
    const message = bus.store.appendMessage(channel.threadId, {
        role: "bot",
        kind: "activity",
        tool: { name, ok },
        from: { botId: from.id, name: from.name, color: from.color },
    });
    bus.broadcast({ kind: "message", threadId: channel.threadId, message });
    bus.store.patchGroup(channel.id, { unread: true });
    bus.broadcastGroup(channel.id);
}
