// Async peer handoff (`delegate_bot`) — pure logic. Each test stands up a
// real Store with throwaway bots, a fake comms-bus (records broadcasts),
// and a runTarget stub that captures the would-be turn so the test can
// assert what would have been dispatched to the harness. The harness itself
// stays out of these — the integration happens in comms.test.ts (the full
// e2e through the agents proxy + fake ACP CLI).
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import {
  drainDelegations,
  queueDelegation,
  _pendingCount,
} from "./delegations.ts";
import { peerAllowKey, resolvePeerComms } from "./peer-approval.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

interface BusPair {
  commsBus: CommsBus;
  approvalBus: { store: Store; broadcast: (payload: unknown) => void };
  broadcasts: unknown[];
  groupBroadcasts: string[];
}

function setupBuses(store: Store): BusPair {
  const broadcasts: unknown[] = [];
  const groupBroadcasts: string[] = [];
  const broadcast = (payload: unknown) => {
    broadcasts.push(payload);
  };
  const broadcastGroup = (id: string) => {
    groupBroadcasts.push(id);
  };
  const commsBus: CommsBus = { store, broadcast, broadcastGroup };
  const approvalBus = { store, broadcast };
  return { commsBus, approvalBus, broadcasts, groupBroadcasts };
}

/** Poll until `predicate` returns a defined value or `timeout` elapses.
 * drainDelegations is fire-and-forget (processOne runs as a Promise) so
 * tests need to wait for its async steps to land. */
async function waitFor<T>(predicate: () => T | undefined, timeout = 2_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = predicate();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("queueDelegation", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let commsBus: CommsBus;
  let broadcasts: unknown[];

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    const buses = setupBuses(store);
    commsBus = buses.commsBus;
    broadcasts = buses.broadcasts;
  });

  it("rejects a self-delegation without queueing", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: from.id,
      message: "self-talk",
      depth: 0,
    }, 1);
    expect(result).toBe("self");
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("rejects when the source turn is already at the depth cap", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: "next task",
      depth: 1,
    }, 1);
    expect(result).toBe("too_deep");
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("rejects when the target bot does not exist", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: "ghost",
      message: "where?",
      depth: 0,
    }, 1);
    expect(result).toBe("no_target");
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("queues, broadcasts, and drops a 'Delegated to @Target' chip on the source thread", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: "do this",
      reason: "followup",
      depth: 0,
    }, 1);
    expect(result).toBe("ok");
    expect(_pendingCount(from.threadId)).toBe(1);

    const chip = store
      .messagesFor(from.threadId)
      .find((m) => m.kind === "activity" && m.tool?.name?.startsWith("Delegated to @"));
    expect(chip?.tool?.name).toBe("Delegated to @Helper: followup");

    // The chip is also broadcast over SSE so chat clients see it without
    // polling /api/bots
    const broadcast = broadcasts.find(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        (b as { kind?: string }).kind === "message" &&
        (b as { threadId?: string }).threadId === from.threadId,
    );
    expect(broadcast).toBeTruthy();
  });
});

describe("drainDelegations", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let commsBus: CommsBus;
  let approvalBus: { store: Store; broadcast: (payload: unknown) => void };
  let runTargetCalls: Array<{ toBotId: string; message: string; commsDepth: number }>;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    const buses = setupBuses(store);
    commsBus = buses.commsBus;
    approvalBus = buses.approvalBus;
    runTargetCalls = [];
  });

  afterEach(() => {
    // Unresolved approval requests carry a 15-min timer that would otherwise
    // keep vitest's event loop alive long after the suite ends. None of the
    // tests above leave one — they all resolve via resolvePeerComms — but
    // double-check by counting the module's pending map: tests that didn't
    // resolve should be re-examined if this ever fires.
    void runTargetCalls;
  });

  it("runs the target's turn via runTarget and mirrors the exchange", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    await waitFor(() => runTargetCalls.length === 1);
    const call = runTargetCalls[0]!;
    expect(call.toBotId).toBe(target.id);
    expect(call.commsDepth).toBe(1);
    expect(call.message).toContain("Delegated by @");
    expect(call.message).toContain("do this");

    // Both 1:1 threads picked up their comm chips, attributed to the
    // source/target bot respectively, linking to the same channel.
    const fromChips = store
      .messagesFor(from.threadId)
      .filter((m) => m.kind === "activity" && m.tool?.name === "Messaged @Helper");
    expect(fromChips).toHaveLength(1);
    const targetChips = store
      .messagesFor(target.threadId)
      .filter((m) => m.kind === "activity" && m.tool?.name === `Message from @${from.name}`);
    expect(targetChips).toHaveLength(1);
    expect(fromChips[0]?.comm?.groupId).toBe(targetChips[0]?.comm?.groupId);
  });

  it("includes the reason line in the prefixed message when one is given", async () => {
    queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: "do this", reason: "next step", depth: 0 },
      1,
    );
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.message).toContain("[Reason: next step]");
  });

  it("skips runTarget and emits a 'no such bot' chip when the target was deleted", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    store.deleteBot(target.id);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    const chip = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.kind === "activity" && (m.tool?.name ?? "").includes("no such bot")),
    );
    expect(chip.tool?.ok).toBe(false);
    expect(runTargetCalls).toEqual([]);
  });

  it("skips runTarget and emits a 'is busy' chip when the target is currently busy", async () => {
    store.patchBot(target.id, { busy: true });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    const chip = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.kind === "activity" && (m.tool?.name ?? "").includes("is busy")),
    );
    expect(chip.tool?.name).toBe("Delegation to @Helper canceled — @Helper is busy");
    expect(chip.tool?.ok).toBe(false);
    expect(runTargetCalls).toEqual([]);
  });

  it("asks for approval when approvePeerComms is on, then runs only on allow", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    // the source bot's thread shows the options card BEFORE runTarget fires
    const card = await waitFor(() =>
      store.messagesFor(from.threadId).find((m) => m.card?.requestId),
    );
    expect(card.card?.title).toContain("delegate to @Helper");
    expect(card.card?.tool).toBe("delegate_bot");
    expect(card.card?.allowKey).toBe(peerAllowKey("delegate_bot", "Helper"));
    expect(card.card?.options).toEqual(["Allow", "Deny", "Always allow"]);
    expect(runTargetCalls).toEqual([]);

    resolvePeerComms(approvalBus, card.card!.requestId!, "allow");
    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.toBotId).toBe(target.id);
    expect(runTargetCalls[0]!.commsDepth).toBe(1);
  });

  it("emits a denial chip and skips runTarget when the user denies", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    const card = await waitFor(() =>
      store.messagesFor(from.threadId).find((m) => m.card?.requestId),
    );
    resolvePeerComms(approvalBus, card.card!.requestId!, "deny");

    const chip = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.kind === "activity" && (m.tool?.name ?? "").includes("denied by user")),
    );
    expect(chip.tool?.ok).toBe(false);
    expect(runTargetCalls).toEqual([]);
  });

  it("auto-allows when alwaysAllow already covers the pair (no card pushed)", async () => {
    store.patchBot(from.id, {
      approvePeerComms: true,
      alwaysAllow: [peerAllowKey("delegate_bot", "Helper")],
    });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.commsDepth).toBe(1);
    const card = store
      .messagesFor(from.threadId)
      .find((m) => m.card?.requestId && m.card.tool === "delegate_bot");
    expect(card).toBeUndefined();
  });

  it("no-ops when nothing is queued for the source thread", () => {
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    expect(runTargetCalls).toEqual([]);
  });

  it("no-ops when the source thread no longer resolves to a bot", () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    store.deleteBot(from.id);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    expect(runTargetCalls).toEqual([]);
  });
});
