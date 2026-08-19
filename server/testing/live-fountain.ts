// Live smoke for the Fountain driver against the REAL fountain CLI + instance.
// Not a test: run by hand. `node --experimental-strip-types server/testing/live-fountain.ts <agent-id>`
import { ensureDirs } from "../config.ts";
import { FountainAgentDriver } from "../drivers/acp/fountain.ts";

ensureDirs();
const agent = process.argv[2];
const instance = await FountainAgentDriver.create({
  instanceId: "fountain-live",
  displayName: "Fountain",
  environment: {},
  enabled: true,
  config: FountainAgentDriver.defaultConfig(),
});
console.log("snapshot", await instance.snapshot());
console.log("catalog", instance.models.options.length, "agents; default", instance.models.default);
const t0 = Date.now();
instance.adapter.onEvent((e) => {
  const { type } = e;
  const extra =
    type === "content.delta" ? JSON.stringify((e as any).delta) :
    type === "session.started" ? (e as any).sessionId :
    type === "turn.completed" ? JSON.stringify({ ok: (e as any).ok, stopReason: (e as any).stopReason }) :
    type === "runtime.error" ? (e as any).message :
    type === "item.started" ? (e as any).title : "";
  console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, type, extra);
});
await instance.adapter.sendTurn({
  threadId: "live-thread",
  text: "Reply with exactly the word PONG and nothing else.",
  model: agent,
  system: "You are Maus, a bot in OpenMausBot.",
});
await new Promise<void>((resolve) => {
  const off = instance.adapter.onEvent((e) => {
    if (e.type === "turn.completed") { off(); resolve(); }
  });
});
await instance.dispose();
