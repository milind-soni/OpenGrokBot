// Contract test for permission-proxy — the MCP stdio server the claude CLI
// spawns for --permission-prompt-tool. A fake broker on the socket stands in
// for the harness, so these assert the two halves of the wire the proxy owns:
// the ask it writes to the broker, and the JSON it hands back to the CLI.
//
// The case that matters most is the CLI's own AskUserQuestion. It arrives
// through `approve` looking like a permission, and answering it as one is why
// a multiple-choice question reached users as an Allow/Deny box over a
// truncated JSON blob. It has to leave here as a question, and come back as
// the `answers` object the tool documents — a bare allow makes the CLI run
// the tool, and a headless run has no dialog, so the click is discarded
// ("The user did not answer the questions.").
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { brokerSocketPath } from "./procs.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "permission-proxy.ts");

/** A question with two labelled options and a per-option explanation — the
 * shape the real CLI sends (verified against claude 2.1.238). */
const QUESTION = {
  questions: [
    {
      question: "Which framework should we use?",
      header: "Framework",
      multiSelect: false,
      options: [
        { label: "React", description: "What the app already uses" },
        { label: "Vue", description: "Smaller, but a rewrite" },
      ],
    },
  ],
};

describe("permission proxy", () => {
  let scratch: string;
  let broker: Server;
  let proxy: ChildProcess;
  /** every ask the broker received, in order */
  let asks: any[];
  /** how the fake broker answers ask N — set per test */
  let answerWith: (ask: any, index: number) => Record<string, unknown> | null;
  /** live broker connections, so a test can drop one mid-ask */
  let conns: Socket[];
  const results = new Map<number, any>();

  const rpc = (msg: unknown) => proxy.stdin!.write(JSON.stringify(msg) + "\n");
  const waitFor = async (id: number, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (results.has(id)) return results.get(id);
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no response for id ${id}; asks so far: ${JSON.stringify(asks)}`);
  };
  const waitForAsks = async (count: number, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (asks.length >= count) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`only ${asks.length} of ${count} asks arrived`);
  };
  /** The tool result the CLI would read, parsed. */
  const resultJson = (res: any) => JSON.parse(res.result.content[0].text);

  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-perm-proxy-"));
    asks = [];
    conns = [];
    answerWith = () => null;
    const socketPath = brokerSocketPath(scratch, "test");
    broker = createServer((conn: Socket) => {
      conns.push(conn);
      let buf = "";
      conn.on("error", () => {});
      conn.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const ask = JSON.parse(line);
          if (ask.t !== "ask") continue;
          const index = asks.length;
          asks.push(ask);
          const answer = answerWith(ask, index);
          if (answer) conn.write(JSON.stringify({ t: "answer", id: ask.id, ...answer }) + "\n");
        }
      });
    });
    await new Promise<void>((resolve) => broker.listen(socketPath, resolve));

    proxy = spawn(process.execPath, ["--experimental-strip-types", PROXY, socketPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    proxy.stdout!.on("data", (chunk) => {
      out += chunk;
      let nl;
      while ((nl = out.indexOf("\n")) !== -1) {
        const line = out.slice(0, nl);
        out = out.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null) results.set(msg.id, msg);
        } catch {
          /* not our frame */
        }
      }
    });
    rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(1);
  }, 20_000);

  afterEach(async () => {
    results.clear();
    proxy?.kill();
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    removeTempDir(scratch);
  });

  it("exposes approve and ask_user", async () => {
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const res = await waitFor(2);
    expect(res.result.tools.map((tool: any) => tool.name)).toEqual(["approve", "ask_user"]);
  });

  it("asks AskUserQuestion as a QUESTION, with the option labels and their explanations", async () => {
    answerWith = () => ({ behavior: "answer", message: "React", source: "user" });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input: QUESTION } },
    });
    const res = await waitFor(2);

    // it left as a question — not a permission, so no card can ever offer
    // an Allow the broker would refuse, and auto mode can never answer it
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      kind: "question",
      tool: "AskUserQuestion",
      input: {
        question: "Which framework should we use?",
        choices: ["React", "Vue"],
        optionHints: { React: "What the app already uses", Vue: "Smaller, but a rewrite" },
        multiSelect: false,
      },
    });

    // and it comes back as the tool's own contract: the original questions,
    // plus an answers object keyed by the question's text
    expect(resultJson(res)).toEqual({
      behavior: "allow",
      updatedInput: { ...QUESTION, answers: { "Which framework should we use?": "React" } },
    });
  });

  it("asks each question of a multi-question call in turn and returns every answer", async () => {
    const input = {
      questions: [
        { question: "Which framework?", options: [{ label: "React" }, { label: "Vue" }] },
        { question: "Which features?", multiSelect: true, options: [{ label: "Auth" }, { label: "Search" }] },
      ],
    };
    answerWith = (_ask, index) => ({ behavior: "answer", message: index === 0 ? "React" : "Auth, Search", source: "user" });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input } },
    });
    const res = await waitFor(2);

    // one card per question, in order — never one answer copied over both
    expect(asks.map((ask) => ask.input.question)).toEqual(["Which framework?", "Which features?"]);
    expect(asks[1].input.multiSelect).toBe(true);
    expect(resultJson(res).updatedInput.answers).toEqual({
      "Which framework?": "React",
      "Which features?": "Auth, Search",
    });
  });

  it("files a timeout's own note as unanswered, not as the user's choice", async () => {
    const input = {
      questions: [
        { question: "Which framework?", options: [{ label: "React" }] },
        { question: "Which features?", options: [{ label: "Auth" }] },
      ],
    };
    // what the broker actually sends on a timeout: `answer`, source "timeout",
    // and a full sentence. A blank-message stand-in never exercised this, which
    // is how the note ended up recorded as the person's chosen option.
    answerWith = (_ask, index) =>
      index === 0
        ? { behavior: "answer", message: "React", source: "user" }
        : {
            behavior: "answer",
            message: "OpenMausBot: nobody answered in time. Use your best judgment and continue.",
            source: "timeout",
          };
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input } },
    });
    expect(resultJson(await waitFor(2)).updatedInput.answers).toEqual({ "Which framework?": "React" });
  });

  it("treats the turn ending the same way — system words are not the user's answer", async () => {
    answerWith = () => ({
      behavior: "answer",
      message: "OpenMausBot: the turn is ending — wrap up.",
      source: "system",
    });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input: QUESTION } },
    });
    expect(resultJson(await waitFor(2)).updatedInput.answers).toEqual({});
  });

  it("stops asking and denies when the broker is gone mid-question", async () => {
    const input = {
      questions: [
        { question: "First?", options: [{ label: "Yes" }] },
        { question: "Second?", options: [{ label: "Yes" }] },
      ],
    };
    answerWith = () => ({ behavior: "deny", message: "OpenMausBot: permission broker unavailable" });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input } },
    });
    const res = await waitFor(2);
    expect(asks).toHaveLength(1); // never asked the second into a dead socket
    expect(resultJson(res)).toMatchObject({ behavior: "deny" });
  });

  it("denies an unanswerable AskUserQuestion instead of carding it as a permission", async () => {
    // Nothing to pick, so nobody can answer it. It must NOT become an
    // Allow/Deny card over raw JSON: allowing that makes the CLI run the tool
    // headless, where it collects nothing and reports "The user did not answer
    // the questions." — the click thrown away, which is the original bug.
    answerWith = () => ({ behavior: "allow" });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "approve",
        arguments: { tool_name: "AskUserQuestion", input: { questions: [{ question: "No options?" }] } },
      },
    });
    const res = await waitFor(2);
    expect(asks).toHaveLength(0); // nobody was interrupted for it
    expect(resultJson(res)).toMatchObject({ behavior: "deny" });
    expect(resultJson(res).message).toContain("no answerable question");
  });

  it("keeps the good questions when one entry in the same call is unanswerable", async () => {
    const input = {
      questions: [
        { question: "Which framework?", options: [{ label: "React" }, { label: "Vue" }] },
        { question: "Anything else?", options: [] },
      ],
    };
    answerWith = () => ({ behavior: "answer", message: "React", source: "user" });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input } },
    });
    const res = await waitFor(2);
    // the answerable one is still asked, and the bad entry costs it nothing
    expect(asks.map((ask) => ask.input.question)).toEqual(["Which framework?"]);
    expect(resultJson(res).updatedInput.answers).toEqual({ "Which framework?": "React" });
  });

  it("still brokers an ordinary permission, with the CLI's own rules on allow", async () => {
    answerWith = () => ({ behavior: "allow", always: true });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "approve",
        arguments: {
          tool_name: "Bash",
          input: { command: "git status" },
          permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }],
        },
      },
    });
    const res = await waitFor(2);
    expect(asks[0]).toMatchObject({ tool: "Bash", input: { command: "git status" } });
    expect(asks[0].kind).toBeUndefined();
    expect(resultJson(res)).toEqual({
      behavior: "allow",
      updatedInput: { command: "git status" },
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }],
    });
  });

  it("still asks ask_user as a question and returns the words verbatim", async () => {
    answerWith = () => ({ behavior: "answer", message: "ship it", source: "user" });
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ask_user", arguments: { question: "Ready?", choices: ["ship it", "wait"] } },
    });
    const res = await waitFor(2);
    expect(asks[0]).toMatchObject({ kind: "question", tool: "ask_user", input: { question: "Ready?" } });
    // a question's answer is text, never a permission envelope
    expect(res.result.content[0].text).toBe("ship it");
  });

  it("denies every waiting ask when the broker dies", async () => {
    answerWith = () => null; // never answers
    rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "Bash", input: { command: "sleep 1" } } },
    });
    await waitForAsks(1);
    for (const conn of conns) conn.destroy();
    const res = await waitFor(2);
    expect(resultJson(res)).toMatchObject({ behavior: "deny" });
  });
});
