// Async peer handoff (delegate_bot).
//
// A bot that finishes one task can hand the NEXT task to a peer without
// blocking its own turn — the source bot's turn.completed fires after it
// settles, and the queued delegation runs then. The peer gets a fresh
// depth-1 turn (depth cap still blocks A→B→C chains, see index.ts).
//
// Visiblity rides on the same comms-visibility helpers ask_bot uses
// (channel mirror + 1:1 chips) so a delegated exchange looks like an
// exchanged one. The optional approval gate (A2) is checked at drain
// time, never at queue time, because the user might have just turned
// approvePeerComms on between queueing and draining.
import { getOrCreateChannel, mirrorExchange } from "./comms-visibility.js";
import { requestPeerApproval } from "./peer-approval.js";
/** Per source-thread queue. Persisted nowhere — a server restart drops
 * delegations the same way provider permissions drop, which is honest:
 * nobody can answer for an unattended bot. */
const pendingDelegations = new Map();
/** How many handoffs one turn may queue. Small on purpose: this is the only
 * thing standing between a confused bot and a fan-out of real turns. */
const MAX_QUEUED_PER_THREAD = 4;
/** Validate and enqueue a delegation. Pushes a "Delegated to @B: reason"
 * chip to the source thread so the user can see what was queued. */
export function queueDelegation(bus, from, item, maxDepth, sourceThreadId = from.threadId) {
    if (item.toBotId === from.id)
        return "self";
    if (item.depth >= maxDepth)
        return "too_deep";
    const target = bus.store.bot(item.toBotId);
    if (!target)
        return "no_target";
    const list = pendingDelegations.get(sourceThreadId) ?? [];
    // Async handoff removes the backpressure that ask_bot got for free by
    // making the caller wait. Without a cap, one turn can queue unboundedly
    // and fan out into as many real turns on the next settle.
    if (list.length >= MAX_QUEUED_PER_THREAD)
        return "too_many";
    list.push(item);
    pendingDelegations.set(sourceThreadId, list);
    const label = `Delegated to @${target.name}${item.reason ? `: ${item.reason}` : ""}`;
    const note = bus.store.appendMessage(sourceThreadId, {
        role: "bot",
        kind: "activity",
        tool: { name: label },
    });
    bus.broadcast({ kind: "message", threadId: sourceThreadId, message: note });
    return "ok";
}
/** Drain queued delegations for a source thread (called on its
 * turn.completed). Each item is processed independently: a deny, a busy
 * target, or an error in one does not stop the rest. The actual start
 * of the target turn is delegated to `runTarget` so delegations.ts
 * stays free of harness-level concerns (commsDepth is the only thing
 * the caller needs). */
export function drainDelegations(bus, approvalBus, threadId, runTarget) {
    const list = pendingDelegations.get(threadId);
    if (!list?.length)
        return;
    pendingDelegations.delete(threadId);
    const from = bus.store.botByThread(threadId);
    if (!from)
        return;
    for (const item of list) {
        void processOne(bus, approvalBus, from, threadId, item, runTarget).catch((error) => {
            const why = error instanceof Error ? error.message : String(error);
            try {
                const note = bus.store.appendMessage(threadId, {
                    role: "bot",
                    kind: "activity",
                    tool: { name: `error: delegation failed — ${why.slice(0, 120)}`, ok: false },
                });
                bus.broadcast({ kind: "message", threadId, message: note });
            }
            catch (reportError) {
                console.error("delegation failed and could not be reported", reportError);
            }
        });
    }
}
/** Drop a thread's queued handoffs without running them, telling the user
 * they were dropped. Used when the queueing turn failed or was interrupted. */
export function discardDelegations(bus, threadId) {
    const list = pendingDelegations.get(threadId);
    if (!list?.length)
        return;
    pendingDelegations.delete(threadId);
    const from = bus.store.botByThread(threadId);
    if (!from)
        return;
    const note = bus.store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `${list.length} queued delegation${list.length > 1 ? "s" : ""} dropped — the turn did not finish`, ok: false },
    });
    bus.broadcast({ kind: "message", threadId, message: note });
}
async function processOne(bus, approvalBus, from, sourceThreadId, item, runTarget) {
    let sender = from;
    let target = bus.store.bot(item.toBotId);
    if (!target) {
        const note = bus.store.appendMessage(sourceThreadId, {
            role: "bot",
            kind: "activity",
            tool: { name: `error: delegation to ${item.toBotId} failed — no such bot`, ok: false },
        });
        bus.broadcast({ kind: "message", threadId: sourceThreadId, message: note });
        return;
    }
    if (target.busy) {
        const note = bus.store.appendMessage(sourceThreadId, {
            role: "bot",
            kind: "activity",
            tool: { name: `Delegation to @${target.name} canceled — @${target.name} is busy`, ok: false },
        });
        bus.broadcast({ kind: "message", threadId: sourceThreadId, message: note });
        return;
    }
    if (sender.approvePeerComms) {
        const verdict = await requestPeerApproval(approvalBus, sender, target, item.message, "delegate_bot", sourceThreadId);
        if (verdict !== "allow") {
            const note = bus.store.appendMessage(sourceThreadId, {
                role: "bot",
                kind: "activity",
                tool: { name: `Delegation to @${target.name} denied by user`, ok: false },
            });
            bus.broadcast({ kind: "message", threadId: sourceThreadId, message: note });
            return;
        }
        // The approval could have been sitting for up to 15 minutes. Everything
        // checked above is a stale snapshot now: re-read both bots and re-check
        // busy, or an allow can start a second turn on a bot that is mid-turn —
        // and mirror a "Messaged @X" chip for an exchange that never happens.
        const current = bus.store.bot(item.toBotId);
        const currentSender = bus.store.bot(from.id);
        if (!current || !currentSender || !bus.store.taskByThread(currentSender.id, sourceThreadId))
            return;
        if (current.busy) {
            const note = bus.store.appendMessage(sourceThreadId, {
                role: "bot",
                kind: "activity",
                tool: { name: `Delegation to @${current.name} canceled — @${current.name} is busy`, ok: false },
            });
            bus.broadcast({ kind: "message", threadId: sourceThreadId, message: note });
            return;
        }
        sender = currentSender;
        target = current;
    }
    const channel = getOrCreateChannel(bus.store, sender, target);
    mirrorExchange(bus, sender, target, item.message, channel, sourceThreadId);
    const reasonLine = item.reason ? `\n\n[Reason: ${item.reason}]` : "";
    const prefixed = `[Delegated by @${sender.name}, another bot in this OpenMausBot workspace. Do the work and reply directly.]\n\n${item.message}${reasonLine}`;
    await runTarget(item.toBotId, prefixed, item.depth + 1, sourceThreadId, channel);
}
/** Test helper: how many items remain queued for a thread. */
export function _pendingCount(threadId) {
    return pendingDelegations.get(threadId)?.length ?? 0;
}
