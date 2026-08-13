// API smoke test: boots the real harness server (node server/index.ts)
// against a throwaway home directory and exercises the HTTP surface the
// app depends on. The config pins one deliberately-unknown driver so the
// suite is deterministic with or without agent CLIs installed — and pins
// the shadow-instance behavior end to end while it's at it.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

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

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-api-test-"));
  // a fleet of exactly one unknown driver: no CLI probes, no network
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(
    join(home, ".openmausbot", "config.json"),
    JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }),
  );

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
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

describe("harness HTTP API", () => {
  it("identifies itself on /api/health", async () => {
    const { status, body } = await api("GET", "/api/health");
    expect(status).toBe(200);
    expect(body.app).toBe("openmausbot");
    expect(typeof body.pid).toBe("number");
  });

  it("seeds one starter bot with its greeting", async () => {
    const { status, body } = await api("GET", "/api/bots");
    expect(status).toBe(200);
    expect(body.bots.length).toBeGreaterThanOrEqual(1);
    expect(body.bots[0].messages.length).toBeGreaterThanOrEqual(2);
  });

  it("describes the configured fleet, shadows included", async () => {
    const { status, body } = await api("GET", "/api/instances");
    expect(status).toBe(200);
    expect(body.instances).toHaveLength(1);
    expect(body.instances[0]).toMatchObject({
      instanceId: "ghost",
      driverKind: "not-a-real-driver",
      displayName: "Ghost",
      snapshot: { state: "unavailable" },
    });
    expect(body.instances[0].snapshot.reason).toContain("not-a-real-driver");
  });

  it("creates, patches, and deletes a bot", async () => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const bot = created.body.bot;

    const patched = await api("PATCH", `/api/bots/${bot.id}`, { name: "Renamed", pinned: true });
    expect(patched.status).toBe(200);
    expect(patched.body.bot).toMatchObject({ name: "Renamed", pinned: true });

    const missing = await api("PATCH", "/api/bots/does-not-exist", { name: "x" });
    expect(missing.status).toBe(404);

    const deleted = await api("DELETE", `/api/bots/${bot.id}`);
    expect(deleted.status).toBe(200);
    const after = await api("GET", "/api/bots");
    expect(after.body.bots.find((b: { id: string }) => b.id === bot.id)).toBeUndefined();
  });

  it("persists an answered onboarding card", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const card = bot.messages.find((m: { kind: string }) => m.kind === "options");
    const res = await api("PATCH", `/api/bots/${bot.id}/cards/${card.id}`, { answered: card.card.options[0] });
    expect(res.status).toBe(200);
    expect(res.body.message.card.answered).toBe(card.card.options[0]);
  });

  it("rejects an empty message and explains an unavailable provider", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];

    const empty = await api("POST", `/api/bots/${bot.id}/messages`, { text: "   " });
    expect(empty.status).toBe(400);

    // the seeded bot's selection points at the ghost instance — sending a
    // real message must fail loudly, not 202-and-hang
    const send = await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello?" });
    expect(send.status).toBe(409);
    expect(send.body.error).toContain("unavailable");
  });

  it("saves config keys write-only and reports booleans", async () => {
    const before = await api("GET", "/api/config");
    expect(before.body.box).toEqual({ configured: false });

    const put = await api("PUT", "/api/config", { box: { token: "tok_secret_value" } });
    expect(put.status).toBe(200);
    expect(put.body.box).toEqual({ configured: true });
    expect(JSON.stringify(put.body)).not.toContain("tok_secret_value");

    const after = await api("GET", "/api/config");
    expect(after.body.box).toEqual({ configured: true });
    expect(JSON.stringify(after.body)).not.toContain("tok_secret_value");

    const nothing = await api("PUT", "/api/config", {});
    expect(nothing.status).toBe(400);
  });

  it("stores and echoes the user profile (not write-only, unlike keys)", async () => {
    const put = await api("PUT", "/api/config", { profile: { name: "Ada Lovelace", email: "Ada@Example.com" } });
    expect(put.status).toBe(200);
    expect(put.body.profile).toEqual({ name: "Ada Lovelace", email: "Ada@Example.com" });

    const after = await api("GET", "/api/config");
    expect(after.body.profile).toEqual({ name: "Ada Lovelace", email: "Ada@Example.com" });
  });

  it("creates, lists, re-schedules, and deletes a routine", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];

    const created = await api("POST", `/api/bots/${bot.id}/routines`, {
      prompt: "  summarize what changed today  ",
      schedule: { kind: "daily", hour: 9, minute: 30 },
    });
    expect(created.status).toBe(201);
    expect(created.body.routine).toMatchObject({
      botId: bot.id,
      prompt: "summarize what changed today",
      title: "summarize what changed today",
      enabled: true,
      schedule: { kind: "daily", hour: 9, minute: 30 },
    });
    expect(created.body.routine.nextRunAt).toBeGreaterThan(Date.now());
    const routineId = created.body.routine.id;

    const listed = await api("GET", `/api/bots/${bot.id}/routines`);
    expect(listed.body.routines.map((r: { id: string }) => r.id)).toEqual([routineId]);

    const paused = await api("PATCH", `/api/routines/${routineId}`, { enabled: false, title: "Daily digest" });
    expect(paused.body.routine).toMatchObject({ enabled: false, title: "Daily digest" });

    const rescheduled = await api("PATCH", `/api/routines/${routineId}`, {
      schedule: { kind: "interval", minutes: 90 },
    });
    expect(rescheduled.body.routine.nextRunAt).toBeGreaterThan(Date.now() + 89 * 60_000);

    expect((await api("DELETE", `/api/routines/${routineId}`)).status).toBe(200);
    expect((await api("GET", `/api/bots/${bot.id}/routines`)).body.routines).toEqual([]);
  });

  it("rejects an invalid routine and 404s unknown ids", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];

    const noPrompt = await api("POST", `/api/bots/${bot.id}/routines`, {
      prompt: "  ",
      schedule: { kind: "daily", hour: 9, minute: 0 },
    });
    expect(noPrompt.status).toBe(400);
    expect(noPrompt.body.error).toContain("prompt");

    const badSchedule = await api("POST", `/api/bots/${bot.id}/routines`, {
      prompt: "do a thing",
      schedule: { kind: "fortnightly" },
    });
    expect(badSchedule.status).toBe(400);
    expect(badSchedule.body.error).toContain("schedule.kind");

    expect((await api("GET", "/api/bots/nope/routines")).status).toBe(404);
    expect((await api("PATCH", "/api/routines/nope", { enabled: false })).status).toBe(404);
    expect((await api("POST", "/api/routines/nope/run")).status).toBe(404);
  });

  it("deletes a bot's routines along with the bot", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const routine = (
      await api("POST", `/api/bots/${bot.id}/routines`, {
        prompt: "check in",
        schedule: { kind: "interval", minutes: 30 },
      })
    ).body.routine;

    await api("DELETE", `/api/bots/${bot.id}`);
    expect((await api("PATCH", `/api/routines/${routine.id}`, { enabled: false })).status).toBe(404);
  });

  it("fires a routine on demand: marks the transcript, advances the clock, reports the failure", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const created = await api("POST", `/api/bots/${bot.id}/routines`, {
      prompt: "run the morning check",
      title: "Morning check",
      schedule: { kind: "interval", minutes: 60 },
    });
    const routine = created.body.routine;

    expect((await api("POST", `/api/routines/${routine.id}/run`)).status).toBe(202);

    // the fire path is async — wait on the transcript that proves it ran
    const deadline = Date.now() + 10_000;
    let activity: Array<{ tool?: { name: string; ok?: boolean } }> = [];
    for (;;) {
      const bots = await api("GET", "/api/bots");
      const messages = bots.body.bots.find((b: { id: string }) => b.id === bot.id).messages;
      activity = messages.filter((msg: { kind: string }) => msg.kind === "activity");
      if (activity.length >= 2 || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // the marker says which routine fired…
    expect(activity[0].tool!.name).toBe("routine: Morning check (every hour)");
    // …and the seeded bot points at the ghost instance, so the turn fails
    // loudly as an activity chip instead of hanging
    expect(activity[1].tool!.name).toContain("routine skipped");
    expect(activity[1].tool!.ok).toBe(false);

    // the clock advanced from the firing, so it cannot hot-loop
    const after = (await api("GET", `/api/bots/${bot.id}/routines`)).body.routines[0];
    expect(after.lastRunAt).toBeGreaterThan(0);
    expect(after.nextRunAt).toBeGreaterThan(routine.nextRunAt - 1);

    await api("DELETE", `/api/routines/${routine.id}`);
  });

  it("groups bots into sections and keeps them when a section is deleted", async () => {
    const created = await api("POST", "/api/sections", { name: "  Work  " });
    expect(created.status).toBe(201);
    expect(created.body.section).toMatchObject({ name: "Work", collapsed: false });
    const sectionId = created.body.section.id;

    const bot = (await api("POST", "/api/bots")).body.bot;
    const filed = await api("PATCH", `/api/bots/${bot.id}`, { sectionId });
    expect(filed.body.bot.sectionId).toBe(sectionId);

    const renamed = await api("PATCH", `/api/sections/${sectionId}`, { name: "Deep work", collapsed: true });
    expect(renamed.body.section).toMatchObject({ name: "Deep work", collapsed: true });

    expect((await api("GET", "/api/sections")).body.sections).toHaveLength(1);

    // deleting the section must NOT take the bot with it
    expect((await api("DELETE", `/api/sections/${sectionId}`)).status).toBe(200);
    expect((await api("GET", "/api/sections")).body.sections).toEqual([]);
    const after = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id);
    expect(after).toBeDefined();
    expect(after.sectionId).toBeNull();

    await api("DELETE", `/api/bots/${bot.id}`);
  });

  it("rejects an unnamed section and filing a bot under one that does not exist", async () => {
    expect((await api("POST", "/api/sections", { name: "   " })).status).toBe(400);
    expect((await api("POST", "/api/sections", { name: "x".repeat(61) })).status).toBe(400);
    expect((await api("PATCH", "/api/sections/nope", { name: "x" })).status).toBe(404);
    expect((await api("DELETE", "/api/sections/nope")).status).toBe(404);

    const { body } = await api("GET", "/api/bots");
    const bad = await api("PATCH", `/api/bots/${body.bots[0].id}`, { sectionId: "not-a-section" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("section");
  });

  it("404s unknown routes with the route in the error", async () => {
    const res = await api("GET", "/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("/api/definitely-not-a-route");
  });
});
