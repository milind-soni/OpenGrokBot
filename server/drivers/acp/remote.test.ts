import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import {
  classifyRemoteAcpError,
  createRemoteAcpDriver,
  decodeRemoteAcpConfig,
  mergeRemoteAcpCatalog,
  parseRemoteAcpCatalog,
  RemoteAcpDriver,
  remoteAcpSpawnArgs,
  type RemoteAcpRunner,
} from "./remote.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const BASE = { cli: "acp", fullAuto: false, workspace: undefined };

// A hosted-agent listing as one such CLI prints it: rows carry more than the
// contract reads, and one of them cannot be driven over ACP.
const AGENT_LIST = JSON.stringify([
  { acp: true, id: "a42e20f6-45e8-4d89-b24a-c428c8cc853c", name: "homelab-builder", runtime: "claude", extra: 3 },
  { acp: false, id: "0d3f0f2e-0000-4000-8000-000000000001", name: "gem", runtime: "gemini" },
  { acp: true, id: "5c1a0000-0000-4000-8000-000000000002", name: "reviewer", runtime: "codex" },
]);

describe("Remote ACP config", () => {
  it("defaults to running the binary bare with no catalog, no auth probe, and no local MCP", () => {
    expect(RemoteAcpDriver.decodeConfig(undefined)).toEqual({
      ...BASE,
      args: [],
      catalog: undefined,
      models: [],
      authCheck: undefined,
      authMethod: undefined,
      mcp: {},
    });
    expect(RemoteAcpDriver.defaultConfig()).toEqual(RemoteAcpDriver.decodeConfig({}));
  });

  it("reads the bridge command, catalog, auth probe, static models, and MCP opt-ins", () => {
    expect(
      decodeRemoteAcpConfig(
        {
          cli: "fountain",
          args: ["acp", "--agent", "{model}"],
          catalog: ["agent", "list", "--json"],
          authCheck: ["auth", "whoami"],
          authMethod: "cached_token",
          models: ["plain-id", { id: "x1", label: "Labelled" }, { id: "x2" }],
          mcp: { computer: true },
          fullAuto: true,
        },
        { cli: "fountain", fullAuto: true, workspace: undefined },
      ),
    ).toEqual({
      cli: "fountain",
      fullAuto: true,
      workspace: undefined,
      args: ["acp", "--agent", "{model}"],
      catalog: ["agent", "list", "--json"],
      authCheck: ["auth", "whoami"],
      authMethod: "cached_token",
      models: [
        { id: "plain-id", label: "plain-id" },
        { id: "x1", label: "Labelled" },
        { id: "x2", label: "x2" },
      ],
      mcp: { computer: true },
    });
  });

  it("rejects a malformed entry with the field named, so the shadow row says why", () => {
    expect(() => decodeRemoteAcpConfig({ args: "acp --agent x" }, BASE)).toThrow(/config\.args/);
    expect(() => decodeRemoteAcpConfig({ catalog: [1] }, BASE)).toThrow(/config\.catalog/);
    expect(() => decodeRemoteAcpConfig({ authCheck: {} }, BASE)).toThrow(/config\.authCheck/);
    expect(() => decodeRemoteAcpConfig({ models: [{ label: "no id" }] }, BASE)).toThrow(/config\.models/);
    expect(() => decodeRemoteAcpConfig({ mcp: { computer: "yes" } }, BASE)).toThrow(/config\.mcp\.computer/);
    expect(() => decodeRemoteAcpConfig({ mcp: [] }, BASE)).toThrow(/config\.mcp/);
    expect(() => decodeRemoteAcpConfig({ authMethod: 7 }, BASE)).toThrow(/config\.authMethod/);
  });
});

describe("Remote ACP catalog", () => {
  it("reads an array of {id, name} rows and skips ones marked acp:false", () => {
    expect(parseRemoteAcpCatalog(AGENT_LIST)).toEqual([
      { id: "a42e20f6-45e8-4d89-b24a-c428c8cc853c", label: "homelab-builder" },
      { id: "5c1a0000-0000-4000-8000-000000000002", label: "reviewer" },
    ]);
  });

  it("prefers label over name over id", () => {
    expect(parseRemoteAcpCatalog(JSON.stringify([{ id: "a", label: "L", name: "N" }, { id: "b", name: "N" }, { id: "c" }]))).toEqual([
      { id: "a", label: "L" },
      { id: "b", label: "N" },
      { id: "c", label: "c" },
    ]);
  });

  it("unwraps the common object envelopes", () => {
    for (const key of ["data", "models", "agents", "items"]) {
      expect(parseRemoteAcpCatalog(JSON.stringify({ [key]: [{ id: "m1" }] }))).toEqual([{ id: "m1", label: "m1" }]);
    }
  });

  it("is empty for garbage, scalars, and rows without a string id", () => {
    expect(parseRemoteAcpCatalog("not json")).toEqual([]);
    expect(parseRemoteAcpCatalog("42")).toEqual([]);
    expect(parseRemoteAcpCatalog(JSON.stringify({ other: [{ id: "x" }] }))).toEqual([]);
    expect(parseRemoteAcpCatalog(JSON.stringify([{ name: "no-id" }, null, 7, { id: 9 }, { id: "" }]))).toEqual([]);
  });

  it("merges static entries ahead of listed ones, first id wins, first entry is the default", () => {
    expect(
      mergeRemoteAcpCatalog(
        [{ id: "pinned", label: "Pinned" }, { id: "dup", label: "Static dup" }],
        [{ id: "dup", label: "Listed dup" }, { id: "listed", label: "Listed" }],
      ),
    ).toEqual({
      default: "pinned",
      options: [
        { id: "pinned", label: "Pinned" },
        { id: "dup", label: "Static dup" },
        { id: "listed", label: "Listed" },
      ],
    });
    expect(mergeRemoteAcpCatalog([], [])).toEqual({ default: "", options: [] });
  });
});

describe("Remote ACP spawn args", () => {
  it("substitutes the pick wherever {model} appears", () => {
    expect(remoteAcpSpawnArgs(["acp", "--agent", "{model}"], "reviewer")).toEqual(["acp", "--agent", "reviewer"]);
    expect(remoteAcpSpawnArgs(["acp", "--agent={model}"], "reviewer")).toEqual(["acp", "--agent=reviewer"]);
    expect(remoteAcpSpawnArgs(["run", "{model}", "--tag", "{model}-x"], "m")).toEqual(["run", "m", "--tag", "m-x"]);
  });

  it("passes a template without the placeholder through untouched", () => {
    expect(remoteAcpSpawnArgs(["acp", "--log-level", "debug"], "reviewer")).toEqual(["acp", "--log-level", "debug"]);
    expect(remoteAcpSpawnArgs([], undefined)).toEqual([]);
  });

  it("drops the placeholder and its flag when nothing is picked, so the bridge runs on its own default", () => {
    expect(remoteAcpSpawnArgs(["acp", "--agent", "{model}"], undefined)).toEqual(["acp"]);
    expect(remoteAcpSpawnArgs(["acp", "--agent", "{model}"], "")).toEqual(["acp"]);
    expect(remoteAcpSpawnArgs(["acp", "--agent={model}"], undefined)).toEqual(["acp"]);
    // a positional before the placeholder is not a flag and stays
    expect(remoteAcpSpawnArgs(["run", "{model}"], undefined)).toEqual(["run"]);
    expect(remoteAcpSpawnArgs(["run", "{model}", "--json"], undefined)).toEqual(["run", "--json"]);
  });
});

describe("Remote ACP error classification", () => {
  it("treats the bridge's sign-in complaints as a setup problem, not a retry", () => {
    for (const text of [
      "credentials for https://f.example were rejected",
      "HTTP 401 Unauthorized",
      "not signed in — run `fountain auth login`",
      "not logged in",
      "request unauthenticated",
    ]) {
      expect(classifyRemoteAcpError(new Error(text))).toBe("invalid_credentials");
    }
  });

  it("leaves everything else unclassified", () => {
    expect(classifyRemoteAcpError(new Error('could not resolve agent "x"'))).toBeUndefined();
    expect(classifyRemoteAcpError(new Error("the sandbox never started: quota"))).toBeUndefined();
    expect(classifyRemoteAcpError(new Error("port 4010 in use"))).toBeUndefined();
    expect(classifyRemoteAcpError(undefined)).toBeUndefined();
  });
});

describe("Remote ACP driver", () => {
  type RawConfig = Parameters<typeof decodeRemoteAcpConfig>[0];
  const create = (driver: ReturnType<typeof createRemoteAcpDriver>, config: RawConfig, environment: Record<string, string> = {}) =>
    driver.create({
      instanceId: "remote-test",
      displayName: "Remote",
      environment,
      enabled: true,
      config: driver.decodeConfig(config),
    });

  it("is a registered cloud-rail engine with no install recipe (the bridge is yours)", () => {
    expect(RemoteAcpDriver.driverKind).toBe("remoteAcp");
    expect(RemoteAcpDriver.metadata).toMatchObject({ displayName: "Remote ACP", access: "subscription" });
    expect(RemoteAcpDriver.install).toBeUndefined();
    expect(BUILT_IN_DRIVERS.some((d) => d.driverKind === "remoteAcp")).toBe(true);
  });

  it("mounts no local MCP integration unless the instance opts in", async () => {
    const driver = createRemoteAcpDriver(async () => ({ ok: true, stdout: "[]" }));
    const closed = await create(driver, {});
    expect(closed.adapter.capabilities).toMatchObject({ agentsMcp: false, computerMcp: false, composioMcp: false });
    await closed.dispose();

    const open = await create(driver, { mcp: { computer: true, agents: true } });
    expect(open.adapter.capabilities).toMatchObject({ agentsMcp: true, computerMcp: true, composioMcp: false });
    await open.dispose();
  });

  it("builds the picker from the catalog command, with the instance's cli and environment", async () => {
    const calls: Array<{ cli: string; args: string[]; env: Record<string, string | undefined> }> = [];
    let listing = AGENT_LIST;
    let ok = true;
    const run: RemoteAcpRunner = async (cli, args, env) => {
      calls.push({ cli, args, env });
      return { ok, stdout: listing };
    };
    const instance = await create(
      createRemoteAcpDriver(run),
      { cli: "/opt/fountain/bin/fountain", catalog: ["agent", "list", "--json"] },
      { FOUNTAIN_BASE_URL: "https://fountain.example" },
    );
    expect(calls[0]).toMatchObject({ cli: "/opt/fountain/bin/fountain", args: ["agent", "list", "--json"] });
    expect(calls[0]!.env.FOUNTAIN_BASE_URL).toBe("https://fountain.example");
    expect(instance.models.default).toBe("a42e20f6-45e8-4d89-b24a-c428c8cc853c");
    expect(instance.models.options.map((o) => o.id)).toEqual([
      "a42e20f6-45e8-4d89-b24a-c428c8cc853c",
      "5c1a0000-0000-4000-8000-000000000002",
    ]);

    // the command failing (signed out, remote down) must not wipe the picker
    ok = false;
    listing = "";
    await instance.refreshModels?.();
    expect(instance.models.options).toHaveLength(2);

    // a changed listing replaces it
    ok = true;
    listing = JSON.stringify({ data: [{ id: "new-1", name: "fresh" }] });
    await instance.refreshModels?.();
    expect(instance.models.options).toEqual([{ id: "new-1", label: "fresh" }]);
    await instance.dispose();
  });

  it("lists static models without any catalog command, and ahead of a listed one", async () => {
    const calls: string[][] = [];
    const run: RemoteAcpRunner = async (_cli, args) => {
      calls.push(args);
      return { ok: true, stdout: JSON.stringify([{ id: "listed" }]) };
    };
    const statics = await create(createRemoteAcpDriver(run), { models: [{ id: "only", label: "Only" }] });
    expect(calls).toEqual([]);
    expect(statics.models).toEqual({ default: "only", options: [{ id: "only", label: "Only" }] });
    await statics.dispose();

    const both = await create(createRemoteAcpDriver(run), { models: ["pinned"], catalog: ["list"] });
    expect(both.models.options.map((o) => o.id)).toEqual(["pinned", "listed"]);
    await both.dispose();
  });

  describe("sign-in probe", () => {
    beforeEach(() => chmodSync(FAKE_CLI, 0o755));

    it("trusts the bridge when no authCheck is configured", async () => {
      const calls: string[][] = [];
      const instance = await create(
        createRemoteAcpDriver(async (_cli, args) => (calls.push(args), { ok: false, stdout: "" })),
        { cli: FAKE_CLI },
      );
      expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
      expect(calls).toEqual([]);
      await instance.dispose();
    });

    it("otherwise runs authCheck and reports its exit status", async () => {
      const calls: string[][] = [];
      let signedIn = false;
      const run: RemoteAcpRunner = async (_cli, args) => {
        calls.push(args);
        return { ok: signedIn, stdout: "" };
      };
      const instance = await create(createRemoteAcpDriver(run), { cli: FAKE_CLI, authCheck: ["auth", "whoami"] });
      expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });
      signedIn = true;
      expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
      expect(calls).toContainEqual(["auth", "whoami"]);
      await instance.dispose();
    });

    it("is unavailable when the bridge binary is not installed", async () => {
      const instance = await create(createRemoteAcpDriver(async () => ({ ok: true, stdout: "" })), {
        cli: "remote-acp-bridge-that-does-not-exist",
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
      scratch = mkdtempSync(join(tmpdir(), "omb-remote-acp-test-"));
    });

    afterEach(async () => {
      delete process.env.FAKE_ACP_MODE;
      delete process.env.FAKE_ACP_DUMP;
      delete process.env.FAKE_ACP_RPC_DUMP;
      recorder?.stop();
      await instance?.dispose();
      await removeTempDir(scratch);
    });

    const start = async (config: RawConfig = {}, environment: Record<string, string> = {}) => {
      instance = await create(
        createRemoteAcpDriver(async () => ({ ok: true, stdout: AGENT_LIST })),
        { cli: FAKE_CLI, args: ["acp", "--agent", "{model}"], catalog: ["agent", "list", "--json"], ...config },
        environment,
      );
      recorder = recordEvents(instance.adapter);
    };

    it("runs a turn on the picked entry and normalizes the canonical event sequence", async () => {
      await start({}, { OMB_TEST_REMOTE_TOKEN: "rt_test" });
      const dump = join(scratch, "dump.json");
      process.env.FAKE_ACP_DUMP = dump;

      const { turnId } = await instance.adapter.sendTurn({
        threadId: "t-remote",
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
      expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "remoteAcp")).toBe(true);
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.argv).toEqual(["acp", "--agent", "a42e20f6-45e8-4d89-b24a-c428c8cc853c"]);
      // the bridge reads its own credentials from the child environment
      expect(seen.env.OMB_TEST_REMOTE_TOKEN).toBe("rt_test");
    });

    it("records the ACP session id as the resume cursor", async () => {
      await start();
      await instance.adapter.sendTurn({ threadId: "t-cursor", text: "hi", model: "reviewer" });
      const started = await recorder.until((e) => e.type === "session.started");
      if (started.type !== "session.started") throw new Error("expected session.started");
      expect(started.sessionId).toBeTruthy();
    });

    it("skips the wire authenticate step by default", async () => {
      await start();
      const rpcDump = join(scratch, "rpc.json");
      process.env.FAKE_ACP_RPC_DUMP = rpcDump;
      await instance.adapter.sendTurn({ threadId: "t-auth", text: "hi", model: "reviewer" });
      await recorder.until((e) => e.type === "turn.completed");
      // SAFETY: FAKE_ACP_RPC_DUMP is the fake's own JSON array of method names.
      const methods = JSON.parse(readFileSync(rpcDump, "utf8")) as string[];
      expect(methods).not.toContain("authenticate");
      expect(methods).toContain("session/new");
      expect(methods).toContain("session/prompt");
    });

    it("authenticates with the configured method when the agent advertises it", async () => {
      await start({ authMethod: "cached_token" });
      const rpcDump = join(scratch, "rpc.json");
      process.env.FAKE_ACP_RPC_DUMP = rpcDump;
      await instance.adapter.sendTurn({ threadId: "t-auth-on", text: "hi", model: "reviewer" });
      await recorder.until((e) => e.type === "turn.completed");
      expect(JSON.parse(readFileSync(rpcDump, "utf8"))).toContain("authenticate");
    });

    it("does not send authenticate for a method the agent never offered", async () => {
      await start({ authMethod: "something-else" });
      const rpcDump = join(scratch, "rpc.json");
      process.env.FAKE_ACP_RPC_DUMP = rpcDump;
      await instance.adapter.sendTurn({ threadId: "t-auth-off", text: "hi", model: "reviewer" });
      await recorder.until((e) => e.type === "turn.completed");
      expect(JSON.parse(readFileSync(rpcDump, "utf8"))).not.toContain("authenticate");
    });

    it("hands the bridge no mcpServers by default — a remote agent never sees this machine's tools", async () => {
      await start();
      const dump = join(scratch, "dump.json");
      process.env.FAKE_ACP_DUMP = dump;
      await instance.adapter.sendTurn({
        threadId: "t-mcp-off",
        text: "hi",
        model: "reviewer",
        integrations: {
          localComputer: { command: "node", args: ["-e", "0"], env: { SECRET: "never-sent" } },
          agents: { command: "node", args: ["-e", "0"], env: {} },
        },
      });
      await recorder.until((e) => e.type === "turn.completed");
      expect(JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8"))).toEqual([]);
    });

    it("forwards exactly the mounts the instance opted into", async () => {
      await start({ mcp: { computer: true } });
      const dump = join(scratch, "dump.json");
      process.env.FAKE_ACP_DUMP = dump;
      await instance.adapter.sendTurn({
        threadId: "t-mcp-on",
        text: "hi",
        model: "reviewer",
        integrations: {
          localComputer: { command: "node", args: ["-e", "0"], env: {} },
          agents: { command: "node", args: ["-e", "0"], env: {} },
        },
      });
      await recorder.until((e) => e.type === "turn.completed");
      // SAFETY: the fake writes session/new's mcpServers array verbatim, each entry named.
      const servers = JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8")) as Array<{ name: string }>;
      expect(servers.map((s) => s.name)).toEqual(["computer"]);
    });
  });
});
