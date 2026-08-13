// Media-specialist MCP proxy. The primary agent receives only the tools
// configured for this bot; generation itself stays in the harness so this
// subprocess never receives provider credentials.
import readline from "node:readline";

const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const TOKEN = process.env.OMB_COMMS_TOKEN ?? "";
const PRIMARY_TURN_ID = process.env.OMB_PRIMARY_TURN_ID ?? "";
const TASKS = new Set(
  (process.env.OMB_MEDIA_TASKS ?? "")
    .split(",")
    .map((task) => task.trim())
    .filter((task) => task === "image" || task === "video"),
);

type MediaTask = "image" | "video";
type Json = Record<string, unknown>;

const toolFor = (task: MediaTask) => ({
  name: `generate_${task}`,
  description: `Generate a ${task} with this bot's configured ${task} specialist and place the finished result in the current chat. Call this when a visual ${task} would fulfill the user's request.`,
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: `A complete, production-ready prompt for the ${task} specialist.` },
    },
    required: ["prompt"],
  },
});

const TOOLS = (["image", "video"] as const).filter((task) => TASKS.has(task)).map(toolFor);
const send = (message: Json) => process.stdout.write(JSON.stringify(message) + "\n");
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) =>
  send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id: unknown, value: string, isError = false) =>
  ok(id, { content: [{ type: "text", text: value }], isError });

async function generate(task: MediaTask, prompt: string): Promise<string> {
  const response = await fetch(`${HARNESS}/api/internal/generate-media`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ botId: BOT_ID, primaryTurnId: PRIMARY_TURN_ID, task, prompt }),
  });
  const body = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok) throw new Error(String(body.error ?? `HTTP ${response.status}`));
  return `The generated ${task} is ready in the chat${body.messageId ? ` (message ${body.messageId})` : ""}. Briefly acknowledge it without repeating the prompt.`;
}

async function handle(message: Json) {
  const id = message.id;
  const method = message.method as string | undefined;
  if (!method) return;
  const params = (message.params ?? {}) as Json;
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: (params.protocolVersion as string) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "openmausbot-media", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = String(params.name ?? "");
      const task = name === "generate_image" ? "image" : name === "generate_video" ? "video" : null;
      if (!task || !TASKS.has(task)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = (params.arguments ?? {}) as Json;
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) return textResult(id, `${name} needs a prompt.`, true);
      if (prompt.length > 20_000) return textResult(id, `${name} prompts are limited to 20,000 characters.`, true);
      try {
        textResult(id, await generate(task, prompt));
      } catch (error) {
        textResult(id, error instanceof Error ? error.message : String(error), true);
      }
      return;
    }
    default:
      if (id !== undefined) rpcError(id, -32601, `Method not found: ${method}`);
  }
}

const lines = readline.createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message: Json;
  try {
    message = JSON.parse(line) as Json;
  } catch {
    return;
  }
  void handle(message).catch((error) => {
    if (message.id !== undefined) rpcError(message.id, -32603, error instanceof Error ? error.message : String(error));
  });
});
lines.on("close", () => process.exit(0));
