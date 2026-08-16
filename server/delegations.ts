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

import { getOrCreateChannel, mirrorExchange, type CommsBus } from "./comms-visibility.ts";
import { requestPeerApproval, type ApprovalBus } from "./peer-approval.ts";
import type { BotRecord } from "./store.ts";

export interface DelegationItem {
  toBotId: string;
  message: string;
  reason?: string;
  /** The source bot's comms depth (0 for a user-initiated turn). The
   * delegated-to bot runs at `depth + 1`, which equals MAX_COMMS_DEPTH
   * (= 1) for a user turn — so the peer has no agents integration, and
   * recursive delegation is structurally impossible. */
  depth: number;
}

export type QueueResult = "ok" | "no_target" | "self" | "too_deep";

/** Per source-thread queue. Persisted nowhere — a server restart drops
 * delegations the same way provider permissions drop, which is honest:
 * nobody can answer for an unattended bot. */
const pendingDelegations = new Map<string, DelegationItem[]>();

/** Validate and enqueue a delegation. Pushes a "Delegated to @B: reason"
 * chip to the source thread so the user can see what was queued. */
export function queueDelegation(
  bus: CommsBus,
  from: BotRecord,
  item: DelegationItem,
  maxDepth: number,
): QueueResult {
  if (item.toBotId === from.id) return "self";
  if (item.depth >= maxDepth) return "too_deep";
  const target = bus.store.bot(item.toBotId);
  if (!target) return "no_target";
  const list = pendingDelegations.get(from.threadId) ?? [];
  list.push(item);
  pendingDelegations.set(from.threadId, list);
  const label = `Delegated to @${target.name}${item.reason ? `: ${item.reason}` : ""}`;
  const note = bus.store.appendMessage(from.threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: label },
  });
  bus.broadcast({ kind: "message", threadId: from.threadId, message: note });
  return "ok";
}

/** Drain queued delegations for a source thread (called on its
 * turn.completed). Each item is processed independently: a deny, a busy
 * target, or an error in one does not stop the rest. The actual start
 * of the target turn is delegated to `runTarget` so delegations.ts
 * stays free of harness-level concerns (commsDepth is the only thing
 * the caller needs). */
export function drainDelegations(
  bus: CommsBus,
  approvalBus: ApprovalBus,
  threadId: string,
  runTarget: (toBotId: string, message: string, commsDepth: number) => void,
): void {
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  pendingDelegations.delete(threadId);
  const from = bus.store.botByThread(threadId);
  if (!from) return;
  for (const item of list) {
    void processOne(bus, approvalBus, from, item, runTarget);
  }
}

async function processOne(
  bus: CommsBus,
  approvalBus: ApprovalBus,
  from: BotRecord,
  item: DelegationItem,
  runTarget: (toBotId: string, message: string, commsDepth: number) => void,
): Promise<void> {
  const target = bus.store.bot(item.toBotId);
  if (!target) {
    const note = bus.store.appendMessage(from.threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `error: delegation to ${item.toBotId} failed — no such bot`, ok: false },
    });
    bus.broadcast({ kind: "message", threadId: from.threadId, message: note });
    return;
  }
  if (target.busy) {
    const note = bus.store.appendMessage(from.threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `Delegation to @${target.name} canceled — @${target.name} is busy`, ok: false },
    });
    bus.broadcast({ kind: "message", threadId: from.threadId, message: note });
    return;
  }
  if (from.approvePeerComms) {
    const verdict = await requestPeerApproval(approvalBus, from, target, item.message, "delegate_bot");
    if (verdict !== "allow") {
      const note = bus.store.appendMessage(from.threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `Delegation to @${target.name} denied by user`, ok: false },
      });
      bus.broadcast({ kind: "message", threadId: from.threadId, message: note });
      return;
    }
  }
  const channel = getOrCreateChannel(bus.store, from, target);
  mirrorExchange(bus, from, target, item.message, channel);
  const reasonLine = item.reason ? `\n\n[Reason: ${item.reason}]` : "";
  const prefixed = `[Delegated by @${from.name}, another bot in this OpenMausBot workspace. Do the work and reply directly.]\n\n${item.message}${reasonLine}`;
  runTarget(item.toBotId, prefixed, item.depth + 1);
}

/** Test helper: how many items remain queued for a thread. */
export function _pendingCount(threadId: string): number {
  return pendingDelegations.get(threadId)?.length ?? 0;
}