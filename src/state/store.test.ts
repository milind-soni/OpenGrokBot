import { describe, expect, it } from "vitest";

import { appReducer, initialState, type Bot, type Message } from "./store";

function videoMessage(status: "generating" | "ready" | "failed" | "cancelled" = "generating"): Message {
  return {
    id: "video-message",
    parentId: "tool-message",
    role: "bot",
    kind: "media",
    at: 3,
    media: [{ id: "video-output", kind: "video", status }],
  };
}

function stateWith(messages: Message[], busy = true) {
  const bot: Bot = {
    id: "bot-1",
    threadId: "thread-1",
    name: "Milind",
    title: "",
    description: "",
    notifications: true,
    color: "blue",
    unread: false,
    busy,
    modelSelection: { instanceId: "openrouter", model: "fixture-video" },
    messages,
    activeLeafId: messages.at(-1)?.id,
  };
  return { ...initialState, bots: [bot], selectedId: bot.id };
}

describe("media lifecycle reconciliation", () => {
  it("removes the active spinner immediately when Stop is clicked", () => {
    const state = stateWith([videoMessage()]);

    const next = appReducer(state, {
      type: "cancelMedia",
      botId: "bot-1",
      messageId: "video-message",
    });

    expect(next.bots[0].messages[0].media?.[0]).toMatchObject({
      status: "cancelled",
      error: "Video generation cancelled",
    });
  });

  it("accepts the canonical media message returned by the Stop endpoint", () => {
    const optimistic = appReducer(stateWith([videoMessage()]), {
      type: "cancelMedia",
      botId: "bot-1",
      messageId: "video-message",
    });
    const canonical = {
      ...videoMessage("cancelled"),
      media: [
        {
          id: "video-output",
          kind: "video" as const,
          status: "cancelled" as const,
          error: "Generation cancelled by provider",
        },
      ],
    };

    const next = appReducer(optimistic, {
      type: "messagePatched",
      threadId: "thread-1",
      message: canonical,
    });

    expect(next.bots[0].messages[0]).toEqual(canonical);
  });

  it("fails any orphaned active media when the bot reports that it is idle", () => {
    const next = appReducer(stateWith([videoMessage()]), {
      type: "botPatched",
      bot: { id: "bot-1", busy: false },
    });

    expect(next.bots[0].messages[0].media?.[0]).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/stopped before completion/i),
    });
  });

  it("removes every active media spinner when the whole bot is stopped", () => {
    const first = videoMessage();
    const second: Message = {
      ...videoMessage(),
      id: "second-video-message",
      media: [{ id: "second-video-output", kind: "video", status: "queued" }],
    };

    const next = appReducer(stateWith([first, second]), { type: "interrupt", botId: "bot-1" });

    expect(next.bots[0].messages.map((message) => message.media?.[0]?.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
  });
});
