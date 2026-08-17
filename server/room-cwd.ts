// How a room member's turn picks its working folder. The room's pinned
// folder is a shared desk — it overrides the member's own default so every
// member works on the same files — except for a member whose engine runs
// with no host filesystem (Grok API, cloud box): its turn happens
// elsewhere, so handing it a host path would point it at a folder it
// cannot reach. Lives outside the dispatch path so the rule is testable
// without booting the server.

/** `memberDefault` is the folder the member would use on its own (its
 * private workspace); undefined = the engine runs off-host. */
export function groupTurnCwd(pinnedRoomCwd: string | null, memberDefault: string | undefined): string | undefined {
  if (memberDefault === undefined) return undefined;
  return pinnedRoomCwd ?? memberDefault;
}
