// End-to-end smoke test for the hermes-os driver against a live hub.
//
// Run from the OpenMausBot checkout:
//   HERMES_OS_URL=http://server.tail85e19.ts.net:8001 \
//     node --experimental-strip-types scripts/smoke-hermes-os.ts
//
// Or run on the homelab server itself (where :8001 is local):
//   HERMES_OS_URL=http://127.0.0.1:8001 node --experimental-strip-types scripts/smoke-hermes-os.ts
//
// The script:
//   1. constructs the driver with HERMES_OS_URL
//   2. asks the hub for /v1/models to confirm reachability
//   3. sends a single turn with the default model
//   4. streams content.delta events to stdout as they arrive
//   5. prints the final turn summary
//   6. exits 0 on success, 1 on failure
//
// Designed to be safe to run from cron or a watchdog — no side effects,
// no writes to disk outside the native-log dir.

import { HermesOsDriver } from "../server/drivers/hermes-os.ts";

const baseUrl = process.env.HERMES_OS_URL ?? "http://127.0.0.1:8001";
const model = process.env.HERMES_OS_MODEL ?? "gemini";
const prompt = process.env.HERMES_OS_PROMPT ?? "Reply with exactly: hermes-os smoke ok";
const apiKey = process.env.HUB_API_TOKEN;

async function main(): Promise<number> {
  console.log(`[smoke] baseUrl=${baseUrl} model=${model} auth=${apiKey ? "yes" : "no"}`);

  const cfg = HermesOsDriver.decodeConfig({ baseUrl, apiKey, defaultModel: model });
  const instance = await HermesOsDriver.create({
    instanceId: "smoke",
    displayName: "smoke",
    environment: {},
    enabled: true,
    config: cfg,
  });

  // 1. reachability
  const snap = await instance.snapshot();
  console.log(`[smoke] snapshot: state=${snap.state} reason=${snap.reason ?? "n/a"}`);
  if (snap.state !== "available") {
    console.error(`[smoke] hub unreachable; aborting`);
    await instance.dispose();
    return 1;
  }

  // 2. send turn
  let text = "";
  let deltas = 0;
  let usage: { input: number; output: number } | null = null;
  let stopReason: string | null = null;
  let ok = false;
  let errors: string[] = [];
  let sessionId: string | null = null;

  const done = new Promise<void>((resolve) => {
    const unsub = instance.adapter.onEvent((e) => {
      switch (e.type) {
        case "session.started":
          sessionId = e.sessionId;
          console.log(`[smoke] session.started sessionId=${e.sessionId} model=${e.model}`);
          break;
        case "turn.started":
          console.log(`[smoke] turn.started`);
          break;
        case "content.delta":
          deltas++;
          process.stdout.write(e.delta);
          break;
        case "item.completed":
          if (e.itemType === "assistant_text") text = e.text;
          break;
        case "thread.token-usage.updated":
          usage = { input: e.input, output: e.output };
          break;
        case "turn.completed":
          ok = e.ok;
          stopReason = e.stopReason ?? null;
          break;
        case "session.exited":
          console.log(`\n[smoke] session.exited reason=${e.reason}`);
          unsub();
          resolve();
          break;
        case "runtime.error":
          errors.push(e.message);
          break;
      }
    });
  });

  await instance.adapter.sendTurn({
    threadId: `smoke-${Date.now()}`,
    text: prompt,
    model,
  });
  await done;
  await instance.dispose();

  console.log(`[smoke] deltas=${deltas} ok=${ok} stopReason=${stopReason} text=${JSON.stringify(text.slice(0, 200))}`);
  if (usage) console.log(`[smoke] usage: in=${usage.input} out=${usage.output}`);
  if (errors.length) console.log(`[smoke] errors: ${JSON.stringify(errors)}`);

  if (!ok || !text) {
    console.error(`[smoke] FAILED: ok=${ok} text-empty=${!text}`);
    return 1;
  }
  if (sessionId == null) {
    console.error(`[smoke] FAILED: no sessionId`);
    return 1;
  }
  console.log(`[smoke] OK`);
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`[smoke] crashed:`, e);
  process.exit(2);
});
