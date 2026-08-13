import { describe, expect, it } from "vitest";

import type { Bot, Message } from "@/state/store";
import { deriveCreations } from "./creations";

function bot(messages: Message[], activeLeafId?: string): Bot {
  return {
    id: "bot-1",
    threadId: "thread-1",
    name: "Maus",
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "openrouter", model: "test" },
    messages,
    activeLeafId,
  };
}

describe("creation index", () => {
  it("derives settled HTML and ready cached media from visible conversations", () => {
    const creations = deriveCreations([
      bot([
        {
          id: "html-message",
          role: "bot",
          kind: "text",
          text: "```html\n<main>Hello</main>\n```",
          at: 10,
        },
        {
          id: "media-message",
          role: "bot",
          kind: "media",
          at: 20,
          media: [
            { id: "image-1", kind: "image", status: "ready", cacheKey: "cache-image.png" },
            { id: "video-1", kind: "video", status: "ready", cacheKey: "cache-video.mp4" },
          ],
        },
      ]),
    ]);

    expect(creations.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "media-message:video-1", kind: "video" },
      { id: "media-message:image-1", kind: "image" },
      { id: "html-message:0", kind: "html" },
    ]);
    expect(creations[0]).toMatchObject({ botId: "bot-1", botName: "Maus", threadId: "thread-1" });
  });

  it("omits failed, pending, uncached, and inactive-branch outputs", () => {
    const creations = deriveCreations([
      bot(
        [
          { id: "root", role: "user", kind: "text", text: "make it", at: 1 },
          {
            id: "visible-html",
            parentId: "root",
            role: "bot",
            kind: "text",
            text: "```html\n<p>Visible</p>\n```",
            at: 2,
          },
          {
            id: "inactive-html",
            parentId: "root",
            role: "bot",
            kind: "text",
            text: "```html\n<p>Inactive</p>\n```",
            at: 3,
          },
          {
            id: "invalid-media",
            parentId: "visible-html",
            role: "bot",
            kind: "media",
            at: 4,
            media: [
              { id: "pending", kind: "image", status: "generating" },
              { id: "failed", kind: "video", status: "failed", error: "no" },
              { id: "uncached", kind: "image", status: "ready" },
            ],
          },
        ],
        "invalid-media",
      ),
    ]);

    expect(creations.map((item) => item.id)).toEqual(["visible-html:0"]);
  });
});
