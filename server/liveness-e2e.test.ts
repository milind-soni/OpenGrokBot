// Turn liveness, end to end: boots the real harness with the fake ACP CLI in
// `hang` mode (a session/prompt that never resolves — the shape of a stuck
// engine) and thresholds shrunk. The quiet flag surfaces after seconds; the
// TurnWatchdog (main's stall guard, floor 60s) then stops the turn with its
// own chip — for a routine in a detached task and for a webhook alike.
//
// Same POSIX gating as branching.test.ts (the fake CLI is a shebang script).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

// the liveness clock ticks every 15s; the watchdog checks every 60s and
// refuses a stall shorter than 60s — so a stop lands within ~2 minutes
const QUIET_AFTER_MS = 2_000;
const STALL_MS = 60_000;

posixOnly("turn liveness e2e (fake ACP in hang mode)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 40_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-liveness-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          hang: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "hang" }, config: { cli: FAKE_CLI, fullAuto: true } },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(PORT),
        OMB_TURN_QUIET_AFTER_MS: String(QUIET_AFTER_MS),
        OMB_TURN_STALL_MS: String(STALL_MS),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it(
    "flags an interactive turn as quiet while it keeps running; Stop clears the note",
    async () => {
      const created = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "hang", model: "fake-model" } });
      expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "hello?" })).status).toBe(202);
      await waitFor(async () => (await getBot(created.id)).busy === true, "the turn to start");

      // the quiet note arrives on the bot broadcast within a tick or two —
      // long before the watchdog's stall floor; the turn keeps running
      await waitFor(async () => typeof (await getBot(created.id)).quietSince === "number", "the quiet flag");
      const bot = await getBot(created.id);
      expect(bot.busy).toBe(true);
      expect(typeof bot.quietSince).toBe("number");

      // the human stops it; the note goes with the turn
      expect((await api("POST", `/api/bots/${created.id}/interrupt`)).status).toBe(200);
      await waitFor(async () => (await getBot(created.id)).busy === false, "the turn to settle");
      expect((await getBot(created.id)).quietSince).toBeUndefined();
    },
    90_000,
  );

  it(
    "a scheduled routine runs in a detached task thread — its quiet state still reaches the bot, then the watchdog stops it",
    async () => {
      const created = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "hang", model: "fake-model" } });
      const routine = await api("POST", "/api/routines", {
        name: "Nightly digest",
        prompt: "summarize the day",
        botId: created.id,
        runOn: "maus",
        schedule: { type: "daily", time: "03:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      });
      expect(routine.status).toBe(201);
      expect((await api("POST", `/api/routines/${routine.body.routine.id}/run`)).status).toBe(201);

      await waitFor(async () => (await getBot(created.id)).busy === true, "the routine turn to start");
      // the routine's task is NOT the thread open in chat: quietSince must
      // still be on the bot broadcast (it is keyed by the routine's thread)
      const during = await getBot(created.id);
      const routineTask = during.tasks.find((t: any) => t.threadId !== created.threadId);
      expect(routineTask, "the routine did not get its own detached task").toBeTruthy();
      await waitFor(async () => typeof (await getBot(created.id)).quietSince === "number", "the quiet flag for the detached task");
      // …then the watchdog's stall floor passes and it stops the turn with its chip
      await waitFor(async () => {
        const b = await getBot(created.id);
        return !b.busy && b.messages.concat(
          // the chip lands on the routine's thread, not the chat thread
          (await api("GET", `/api/threads/${routineTask.threadId}/messages`)).body?.messages ?? [],
        ).some((m: any) => m.kind === "activity" && /no activity for \d+ minutes? — the turn was stopped/.test(m.tool?.name ?? ""));
      }, "the routine turn to be stopped by the watchdog", 150_000);
      expect((await getBot(created.id)).quietSince).toBeUndefined();
    },
    180_000,
  );

  it(
    "a webhook-started turn is flagged quiet, then stopped by the watchdog with its chip",
    async () => {
      const created = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "hang", model: "fake-model" } });
      const hook = await api("POST", "/api/webhooks", { name: "Nightly", prompt: "handle it", botId: created.id, runOn: "maus" });
      expect(hook.status).toBe(201);
      const delivered = await fetch(hook.body.credential.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "failed" }),
      });
      expect(delivered.status).toBe(202);

      await waitFor(async () => (await getBot(created.id)).busy === true, "the webhook turn to start");
      // a webhook run gets its own detached task, like a routine
      const webhookTask = (await getBot(created.id)).tasks.find((t: any) => t.threadId !== created.threadId);
      expect(webhookTask, "the webhook did not get its own detached task").toBeTruthy();
      // flagged first…
      await waitFor(async () => typeof (await getBot(created.id)).quietSince === "number", "the quiet flag");
      // …then the watchdog stops it, with its chip explaining why
      await waitFor(async () => {
        const b = await getBot(created.id);
        const threadMessages = (await api("GET", `/api/threads/${webhookTask.threadId}/messages`)).body?.messages ?? [];
        return !b.busy && threadMessages.some((m: any) => m.kind === "activity" && /no activity for \d+ minutes? — the turn was stopped/.test(m.tool?.name ?? ""));
      }, "the webhook turn to be stopped by the watchdog", 150_000);
      expect((await getBot(created.id)).quietSince).toBeUndefined();
    },
    180_000,
  );
});
