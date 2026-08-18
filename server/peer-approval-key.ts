export type PeerAction = "ask_bot" | "delegate_bot";

/** Stable persisted grant for one peer action and one target bot. */
export function peerAllowKey(action: PeerAction, targetId: string): string {
  return `${action}:${targetId}`;
}
