// End-to-end smoke test for the ai-counsel driver against a live
// the-ai-counsel backend (jacob-bd/the-ai-counsel, MIT).
//
// Run from the OpenMausBot checkout:
//   AI_COUNSEL_URL=http://server.tail85e19.ts.net:8021 \
//     node --experimental-strip-types scripts/smoke-ai-counsel.ts
//
// Or run on the homelab server itself (where :8020 is local):
//   AI_COUNSEL_URL=http://127.0.0.1:8020 node --experimental-strip-types scripts/smoke-ai-counsel.ts
//
// Note: the smoke uses the local Ollama seat (free, fast) by default so
// it works without spending OpenRouter credits. Override with
// AI_COUNSEL_MODEL=openai/gpt-4.1 to use a real model.
//
// The script:
//   1. constructs the driver with AI_COUNSEL_URL
//   2. asks the counsel for /api/conversations to confirm reachability
//   3. sends a single turn
//   4. prints the per-seat assistant_text events as they arrive
//   5. prints the final synthesis + turn summary
//   6. exits 0 on success, 1 on failure

import { AiCounselDriver } from "../server/drivers/ai-counsel.ts";

const baseUrl = process.env.AI_COUNSEL_URL ?? "http://127.0.0.1:8020";
const model = process.env.AI_COUNSEL_MODEL ?? "ollama:hermes3:8b";
const prompt = process.env.AI_COUNSEL_PROMPT ?? "Reply with exactly: ai-counsel smoke ok";

async function main(): Promise<number> {
  console.log(`[smoke] baseUrl=${baseUrl} model=${model}`);

  const cfg = AiCounselDriver.decodeConfig({ baseUrl, defaultModel: model });
  const instance = await AiCounselDriver.create({
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
    console.error(`[smoke] counsel unreachable; aborting`);
    await instance.dispose();
    return 1;
  }

  // 2. send turn
  let synthesis = "";
  let seats: Array<{ stage: string; model: string; text: string }> = [];
  let errors: string[] = [];
  let stopReason: string | null = null;
  let ok = false;
  let sessionId: string | null = null;
  let usageTotal = { input: 0, output: 0 };

  const done = new Promise<void>((resolve) => {
    // title is on item.started; item.completed carries the same itemId so we
    // pair them up to get a labeled text for the smoke output.
    const titles = new Map<string, string>();
    const unsub = instance.adapter.onEvent((e) => {
      switch (e.type) {
        case "session.started":
          sessionId = e.sessionId;
          console.log(`[smoke] session.started sessionId=${e.sessionId} model=${e.model}`);
          break;
        case "turn.started":
          console.log(`[smoke] turn.started`);
          break;
        case "item.started":
          if (e.itemId && e.title) titles.set(e.itemId, e.title);
          break;
        case "item.completed":
          if (e.itemType === "assistant_text" && e.itemId) {
            const title = titles.get(e.itemId) ?? "seat";
            const stage = title.match(/^(\S+)/)?.[1] ?? "seat";
            const modelMatch = title.match(/\(([^)]+)\)$/)?.[1] ?? "unknown";
            seats.push({ stage, model: modelMatch, text: e.text });
            console.log(`[smoke] ${stage.padEnd(20)} [${modelMatch}] ${e.text.slice(0, 120).replace(/\n/g, "\\n")}${e.text.length > 120 ? "..." : ""}`);
            // The last assistant_text is the synthesis (stage3)
            synthesis = e.text;
          }
          break;
        case "thread.token-usage.updated":
          usageTotal.input += e.input;
          usageTotal.output += e.output;
          break;
        case "turn.completed":
          ok = e.ok;
          stopReason = e.stopReason ?? null;
          break;
        case "session.exited":
          console.log(`[smoke] session.exited reason=${e.reason}`);
          unsub();
          resolve();
          break;
        case "runtime.error":
          errors.push(e.message);
          console.error(`[smoke] runtime.error: ${e.message}`);
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

  console.log(`[smoke] seats: ${seats.length} (stage1=${seats.filter(s => s.stage.startsWith("stage1")).length}, stage2=${seats.filter(s => s.stage.startsWith("stage2")).length}, stage3=${seats.filter(s => s.stage.startsWith("stage3")).length})`);
  console.log(`[smoke] ok=${ok} stopReason=${stopReason}`);
  console.log(`[smoke] usage: in=${usageTotal.input} out=${usageTotal.output}`);
  if (errors.length) console.log(`[smoke] errors: ${JSON.stringify(errors)}`);
  console.log(`[smoke] synthesis: ${JSON.stringify(synthesis.slice(0, 200))}`);

  if (!ok || !synthesis) {
    console.error(`[smoke] FAILED: ok=${ok} synthesis-empty=${!synthesis}`);
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
