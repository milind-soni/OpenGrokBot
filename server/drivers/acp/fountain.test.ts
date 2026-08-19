import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import {
  classifyFountainError,
  createFountainAgentDriver,
  FountainAgentDriver,
  fountainSpawnArgs,
  parseFountainAgentCatalog,
  type FountainCliRunner,
} from "./fountain.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

// Two rows as `fountain agent list --json` prints them (fields the catalog
// ignores trimmed): a claude agent, a gemini agent that cannot speak ACP.
const AGENT_LIST = JSON.stringify([
  {
    acp: true,
    id: "a42e20f6-45e8-4d89-b24a-c428c8cc853c",
    name: "homelab-builder",
    runtime: "claude",
    model: "anthropic/claude-opus-4-7",
    conversation_count: 3,
  },
  { acp: false, id: "0d3f0f2e-0000-4000-8000-000000000001", name: "gem", runtime: "gemini", model: "gemini-2.5-pro" },
  { acp: true, id: "5c1a0000-0000-4000-8000-000000000002", name: "reviewer", runtime: "codex", model: "gpt-5" },
]);

describe("Fountain agent catalog", () => {
  it("lists ACP-capable agents by id, labelled with runtime and model", () => {
    const catalog = parseFountainAgentCatalog(AGENT_LIST);
    expect(catalog.default).toBe("a42e20f6-45e8-4d89-b24a-c428c8cc853c");
    expect(catalog.options).toEqual([
      { id: "a42e20f6-45e8-4d89-b24a-c428c8cc853c", label: "homelab-builder (claude · anthropic/claude-opus-4-7)" },
      { id: "5c1a0000-0000-4000-8000-000000000002", label: "reviewer (codex · gpt-5)" },
    ]);
  });

  it("drops agents whose runtime does not speak ACP", () => {
    const ids = parseFountainAgentCatalog(AGENT_LIST).options.map((o) => o.id);
    expect(ids).not.toContain("0d3f0f2e-0000-4000-8000-000000000001");
  });

  it("is empty for garbage, a non-array, and rows without an id", () => {
    expect(parseFountainAgentCatalog("not json")).toEqual({ default: "", options: [] });
    expect(parseFountainAgentCatalog(JSON.stringify({ agents: [] }))).toEqual({ default: "", options: [] });
    expect(parseFountainAgentCatalog(JSON.stringify([{ name: "no-id" }, null, 7]))).toEqual({
      default: "",
      options: [],
    });
  });

  it("falls back to the id as the label when the row has no name or detail", () => {
    const catalog = parseFountainAgentCatalog(JSON.stringify([{ id: "abc" }]));
    expect(catalog.options).toEqual([{ id: "abc", label: "abc" }]);
  });
});

describe("Fountain spawn args", () => {
  it("names the picked agent and nothing else by default", () => {
    expect(fountainSpawnArgs("homelab-builder", {})).toEqual(["acp", "--agent", "homelab-builder"]);
  });

  it("passes an empty model through as no --agent so the adapter reports it", () => {
    expect(fountainSpawnArgs(undefined, {})).toEqual(["acp"]);
    expect(fountainSpawnArgs("", {})).toEqual(["acp"]);
  });

  it("turns the instance's vault and environment knobs into flags", () => {
    expect(
      fountainSpawnArgs("a1", { FOUNTAIN_ACP_VAULT: "buzz-identity", FOUNTAIN_ACP_ENVIRONMENT: "staging" }),
    ).toEqual(["acp", "--agent", "a1", "--vault", "buzz-identity", "--environment", "staging"]);
  });

  it("leaves credentials and profile to the CLI's own environment lookup", () => {
    expect(
      fountainSpawnArgs("a1", { FOUNTAIN_API_KEY: "k", FOUNTAIN_BASE_URL: "https://x", FOUNTAIN_PROFILE: "p" }),
    ).toEqual(["acp", "--agent", "a1"]);
  });
});

describe("Fountain error classification", () => {
  it("treats rejected credentials as a sign-in problem, not a retry", () => {
    expect(classifyFountainError(new Error("credentials for https://f.example were rejected"))).toBe(
      "invalid_credentials",
    );
    expect(classifyFountainError(new Error("HTTP 401 Unauthorized"))).toBe("invalid_credentials");
  });

  it("leaves everything else unclassified", () => {
    expect(classifyFountainError(new Error('could not resolve agent "x" on https://f.example'))).toBeUndefined();
    expect(classifyFountainError(new Error("the sandbox never started: quota"))).toBeUndefined();
    expect(classifyFountainError(undefined)).toBeUndefined();
  });
});

describe("Fountain driver", () => {
  it("is a cloud-rail ACP engine over the fountain CLI", () => {
    expect(FountainAgentDriver.driverKind).toBe("fountainAgent");
    expect(FountainAgentDriver.metadata).toMatchObject({ displayName: "Fountain", access: "subscription" });
    expect(FountainAgentDriver.decodeConfig(undefined)).toEqual({ cli: "fountain", fullAuto: false, workspace: undefined });
    expect(FountainAgentDriver.install?.signInCommand).toBe("fountain auth login");
    expect(FountainAgentDriver.install?.command?.darwin).toContain("brew install");
  });

  it("declares no MCP integrations: the agent runs in a sandbox that ignores mcpServers", async () => {
    const instance = await createFountainAgentDriver(async () => ({ ok: false, stdout: "" })).create({
      instanceId: "fountain-caps",
      displayName: "Fountain",
      environment: {},
      enabled: true,
      config: FountainAgentDriver.defaultConfig(),
    });
    expect(instance.adapter.capabilities).toMatchObject({
      sessionModelSwitch: "unsupported",
      agentsMcp: false,
      computerMcp: false,
      composioMcp: false,
    });
    expect(instance.adapter.capabilities.effortLevels).toBeUndefined();
    await instance.dispose();
  });

  it("builds the picker from `fountain agent list --json` and keeps the last catalog on failure", async () => {
    const calls: string[][] = [];
    let listing = AGENT_LIST;
    let ok = true;
    const run: FountainCliRunner = async (args) => {
      calls.push(args);
      return { ok, stdout: listing };
    };
    const instance = await createFountainAgentDriver(run).create({
      instanceId: "fountain-catalog",
      displayName: "Fountain",
      environment: {},
      enabled: true,
      config: FountainAgentDriver.defaultConfig(),
    });
    expect(calls).toContainEqual(["agent", "list", "--json"]);
    expect(instance.models.options.map((o) => o.id)).toEqual([
      "a42e20f6-45e8-4d89-b24a-c428c8cc853c",
      "5c1a0000-0000-4000-8000-000000000002",
    ]);

    // the CLI failing (signed out, instance down) must not wipe the picker
    ok = false;
    listing = "";
    await instance.refreshModels?.();
    expect(instance.models.options).toHaveLength(2);

    // a changed listing replaces it
    ok = true;
    listing = JSON.stringify([{ id: "new-1", name: "fresh", runtime: "claude", acp: true }]);
    await instance.refreshModels?.();
    expect(instance.models.options.map((o) => o.id)).toEqual(["new-1"]);
    await instance.dispose();
  });

  it("gives the catalog runner the instance environment (base URL, key, profile)", async () => {
    let seenEnv: Record<string, string | undefined> = {};
    const run: FountainCliRunner = async (_args, env) => {
      seenEnv = env;
      return { ok: true, stdout: "[]" };
    };
    const instance = await createFountainAgentDriver(run).create({
      instanceId: "fountain-env",
      displayName: "Fountain",
      environment: { FOUNTAIN_BASE_URL: "https://fountain.example", FOUNTAIN_PROFILE: "work" },
      enabled: true,
      config: FountainAgentDriver.defaultConfig(),
    });
    expect(seenEnv.FOUNTAIN_BASE_URL).toBe("https://fountain.example");
    expect(seenEnv.FOUNTAIN_PROFILE).toBe("work");
    await instance.dispose();
  });

  describe("sign-in probe", () => {
    it("trusts FOUNTAIN_API_KEY without asking the CLI", async () => {
      const calls: string[][] = [];
      const run: FountainCliRunner = async (args) => {
        calls.push(args);
        return { ok: true, stdout: "[]" };
      };
      const instance = await createFountainAgentDriver(run).create({
        instanceId: "fountain-key",
        displayName: "Fountain",
        environment: { FOUNTAIN_API_KEY: "fk_test" },
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      });
      chmodSync(FAKE_CLI, 0o755);
      const snap = await instance.snapshot();
      expect(snap).toMatchObject({ state: "available", authenticated: true });
      expect(calls.some((a) => a[0] === "auth")).toBe(false);
      await instance.dispose();
    });

    it("otherwise asks `fountain auth whoami` and reports its verdict", async () => {
      const calls: string[][] = [];
      let signedIn = false;
      const run: FountainCliRunner = async (args) => {
        calls.push(args);
        if (args[0] === "auth") return { ok: signedIn, stdout: "" };
        return { ok: true, stdout: "[]" };
      };
      const instance = await createFountainAgentDriver(run).create({
        instanceId: "fountain-whoami",
        displayName: "Fountain",
        environment: {},
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      });
      chmodSync(FAKE_CLI, 0o755);
      expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });
      signedIn = true;
      expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
      expect(calls).toContainEqual(["auth", "whoami"]);
      await instance.dispose();
    });

    it("is unavailable when the CLI is not installed", async () => {
      const instance = await createFountainAgentDriver(async () => ({ ok: false, stdout: "" })).create({
        instanceId: "fountain-missing",
        displayName: "Fountain",
        environment: {},
        enabled: true,
        config: { cli: "fountain-cli-that-does-not-exist", fullAuto: false },
      });
      expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
      await instance.dispose();
    });
  });

  describe("turns through the fake ACP CLI", () => {
    let instance: ProviderInstance;
    let recorder: EventRecorder;
    let scratch: string;

    beforeEach(() => {
      ensureDirs();
      chmodSync(FAKE_CLI, 0o755);
      scratch = mkdtempSync(join(tmpdir(), "omb-fountain-test-"));
    });

    afterEach(async () => {
      delete process.env.FAKE_ACP_MODE;
      delete process.env.FAKE_ACP_DUMP;
      recorder?.stop();
      await instance?.dispose();
      await removeTempDir(scratch);
    });

    const create = async (environment: Record<string, string> = {}) => {
      instance = await createFountainAgentDriver(async () => ({ ok: true, stdout: AGENT_LIST })).create({
        instanceId: "fountain-e2e",
        displayName: "Fountain",
        environment,
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      });
      recorder = recordEvents(instance.adapter);
    };

    it("runs a turn on the picked agent and normalizes the canonical event sequence", async () => {
      await create({ FOUNTAIN_API_KEY: "fk_test", FOUNTAIN_BASE_URL: "https://fountain.example" });
      const dump = join(scratch, "dump.json");
      process.env.FAKE_ACP_DUMP = dump;

      const { turnId } = await instance.adapter.sendTurn({
        threadId: "t-fountain",
        text: "hi",
        model: "a42e20f6-45e8-4d89-b24a-c428c8cc853c",
        system: "You are Maus.",
      });
      await recorder.until((e) => e.type === "turn.completed");

      expect(recorder.events.map((e) => e.type)).toEqual([
        "turn.started",
        "session.started",
        "content.delta",
        "item.started",
        "item.completed",
        "thread.token-usage.updated",
        "item.completed",
        "turn.completed",
      ]);
      expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "fountainAgent")).toBe(true);
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.argv).toEqual(["acp", "--agent", "a42e20f6-45e8-4d89-b24a-c428c8cc853c"]);
      // the CLI reads its own credentials from the child environment
      expect(seen.env.FOUNTAIN_API_KEY).toBe("fk_test");
      expect(seen.env.FOUNTAIN_BASE_URL).toBe("https://fountain.example");
    });

    it("hands the instance's vault and environment overrides to `fountain acp`", async () => {
      await create({ FOUNTAIN_ACP_VAULT: "nostr-identity", FOUNTAIN_ACP_ENVIRONMENT: "prod-env" });
      const dump = join(scratch, "dump.json");
      process.env.FAKE_ACP_DUMP = dump;

      await instance.adapter.sendTurn({ threadId: "t-vault", text: "hi", model: "reviewer" });
      await recorder.until((e) => e.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.argv).toEqual([
        "acp",
        "--agent",
        "reviewer",
        "--vault",
        "nostr-identity",
        "--environment",
        "prod-env",
      ]);
    });

    it("keeps the conversation id as the resume cursor: session.started carries the ACP session id", async () => {
      await create();
      await instance.adapter.sendTurn({ threadId: "t-cursor", text: "hi", model: "reviewer" });
      const started = await recorder.until((e) => e.type === "session.started");
      if (started.type !== "session.started") throw new Error("expected session.started");
      expect(started.sessionId).toBeTruthy();
    });

    it("skips the wire authenticate step (the CLI holds the credentials)", async () => {
      await create();
      const rpcDump = join(scratch, "rpc.json");
      process.env.FAKE_ACP_RPC_DUMP = rpcDump;
      try {
        await instance.adapter.sendTurn({ threadId: "t-auth", text: "hi", model: "reviewer" });
        await recorder.until((e) => e.type === "turn.completed");
        const methods = JSON.parse(readFileSync(rpcDump, "utf8")) as string[];
        expect(methods).not.toContain("authenticate");
        expect(methods).toContain("session/new");
        expect(methods).toContain("session/prompt");
      } finally {
        delete process.env.FAKE_ACP_RPC_DUMP;
      }
    });
  });
});
