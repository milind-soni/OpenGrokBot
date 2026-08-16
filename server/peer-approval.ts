// Harness-native peer-comm approval gate.
//
// A bot with `approvePeerComms = true` may not call ask_bot or
// delegate_bot without a human approving the specific contact. The
// approval rides on the same options-card flow provider permissions
// already use: a card pushed into the SOURCE bot's thread with a
// `requestId`, answered by the user via /api/bots/:id/respond (or
// /api/threads/:id/respond) which the harness intercepts via
// `resolvePeerComms` BEFORE forwarding to the provider adapter. That
// way nothing front-end has to learn about peer comms.
//
// "Always allow" rides on the existing per-bot `alwaysAllow` list. The
// card carries an `allowKey` (`ask_bot:@Name` / `delegate_bot:@Name`) and
// the user-facing Always-allow flow already mirrors that key back into
// `alwaysAllow`, so the two sides never disagree about what was granted.

import { newId } from "./contracts.ts";
import type { BotRecord, Message, Store } from "./store.ts";

/** What a peer-approval helper needs from the outside world: the store
 * for thread append + persist, and the SSE broadcaster so the chat
 * updates without waiting for a refresh. */
export interface ApprovalBus {
  store: Store;
  /** SSE broadcast (kind: "message" envelope). */
  broadcast: (payload: unknown) => void;
}

interface Pending {
  resolve: (result: "allow" | "deny") => void;
  /** Frees the requestId if the user never answers. */
  timer: ReturnType<typeof setTimeout>;
  fromBotId: string;
  toBotId: string;
  message: string;
}

/** requestId → pending ask. Lives only in memory — restarting the
 * server cancels every in-flight approval, like provider permissions do. */
const pendingComms = new Map<string, Pending>();

const APPROVAL_TIMEOUT_MS = 15 * 60_000;

/** The narrow grant "always allow" remembers for a peer comm. Mirrored
 * back into `bot.alwaysAllow` when the user picks "Always allow" on the
 * card. */
export function peerAllowKey(action: "ask_bot" | "delegate_bot", targetName: string): string {
  return `${action}:@${targetName}`;
}

function allowKeyAllowed(from: BotRecord, allowKey: string): boolean {
  return from.alwaysAllow?.includes(allowKey) ?? false;
}

function pushApprovalCard(
  bus: ApprovalBus,
  from: BotRecord,
  target: BotRecord,
  message: string,
  action: "ask_bot" | "delegate_bot",
  requestId: string,
): Message {
  const subtitle = message.length > 200 ? `${message.slice(0, 200)}…` : message;
  const note = bus.store.appendMessage(from.threadId, {
    role: "bot",
    kind: "options",
    card: {
      title: `@${from.name} wants to ${action === "ask_bot" ? "contact" : "delegate to"} @${target.name}`,
      subtitle,
      options: ["Allow", "Deny", "Always allow"],
      requestId,
      tool: action,
      allowKey: peerAllowKey(action, target.name),
    },
  });
  bus.broadcast({ kind: "message", threadId: from.threadId, message: note });
  return note;
}

/** Ask the user (in `from`'s thread) whether `from` may `action` `target`.
 * Resolves with `"allow"` or `"deny"`. If `from.alwaysAllow` already
 * covers the (action, target) pair, returns `"allow"` immediately
 * without a card. */
export function requestPeerApproval(
  bus: ApprovalBus,
  from: BotRecord,
  target: BotRecord,
  message: string,
  action: "ask_bot" | "delegate_bot",
): Promise<"allow" | "deny"> {
  if (allowKeyAllowed(from, peerAllowKey(action, target.name))) {
    return Promise.resolve("allow");
  }
  return new Promise((resolve) => {
    const requestId = newId();
    const timer = setTimeout(() => {
      // 15 minutes without an answer → deny. Keeps an unattended bot from
      // stalling its own turn forever (matches the Claude broker timeout).
      if (pendingComms.delete(requestId)) resolve("deny");
    }, APPROVAL_TIMEOUT_MS);
    pendingComms.set(requestId, {
      resolve,
      timer,
      fromBotId: from.id,
      toBotId: target.id,
      message,
    });
    pushApprovalCard(bus, from, target, message, action, requestId);
  });
}

/** Called by the respond endpoints BEFORE forwarding to the provider
 * adapter. Returns true if the requestId belonged to a pending peer
 * approval (and resolves it); false if it was a provider request and
 * the endpoint should keep going. */
export function resolvePeerComms(
  _bus: ApprovalBus,
  requestId: string,
  behavior: string | undefined,
): boolean {
  const pending = pendingComms.get(requestId);
  if (!pending) return false;
  pendingComms.delete(requestId);
  clearTimeout(pending.timer);
  const allow = behavior === "allow";
  pending.resolve(allow ? "allow" : "deny");
  return true;
}