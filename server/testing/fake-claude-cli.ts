#!/usr/bin/env node
// Fake of the claude CLI's stream-json surface, for driver tests.
// Reads the prompt from stdin (one stream-json line), then plays a
// scripted session. Failure modes are toggled by env var, mirroring how
// the real thing misbehaves:
//
//   FAKE_CLAUDE_MODE   happy (default) | exit-early | hang | malformed
//   FAKE_CLAUDE_DUMP   path to write {argv, env, prompt} as JSON, so the
//                      test can assert on argv shape and env hygiene
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_CLAUDE_MODE ?? "happy";

const argv = process.argv.slice(2);
const argAfter = (flag: string): string | null => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  let prompt: unknown = null;
  try {
    prompt = JSON.parse(stdin.split("\n").find((l) => l.trim()) ?? "null");
  } catch {
    /* leave null — the test will see it */
  }

  if (process.env.FAKE_CLAUDE_DUMP) {
    writeFileSync(process.env.FAKE_CLAUDE_DUMP, JSON.stringify({ argv, env: process.env, prompt }, null, 2));
  }

  const sessionId = argAfter("--resume") ?? argAfter("--session-id") ?? "fake-session";
  const model = argAfter("--model") ?? "claude-fake";

  if (mode === "exit-early") {
    process.stderr.write("fake-claude: simulated crash before result\n");
    process.exit(3);
  }

  out({ type: "system", subtype: "init", session_id: sessionId, model });

  if (mode === "hang") {
    // stay alive until killed — lets tests exercise interrupt + the
    // permission broker while a turn is officially in flight
    setInterval(() => {}, 1_000);
    return;
  }

  if (mode === "malformed") {
    process.stdout.write("this is not json\n{broken\n");
  }

  out({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "hello from fake claude" },
        { type: "tool_use", id: "tu-1", name: "Bash" },
      ],
      usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 },
    },
  });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", is_error: false }] } });
  out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0.01 });
  process.exit(0);
});
