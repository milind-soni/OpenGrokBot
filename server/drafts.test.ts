import { describe, expect, it } from "vitest";

import {
  getDraft,
  getDraftAttachments,
  setDraft,
  setDraftAttachments,
} from "../src/lib/drafts.ts";
import { fileAttachment, pasteAttachment } from "../src/lib/composer-attachments.ts";

function memoryStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("composer drafts", () => {
  it("keeps text and attachments isolated per bot or room", () => {
    const store = memoryStore();
    const paste = pasteAttachment("bot paste");
    const file = fileAttachment("notes.txt", "/tmp/notes.txt", 12);
    setDraft(store, "bot:one", "hello");
    setDraftAttachments(store, "bot:one", [paste, file]);
    setDraft(store, "group:two", "room text");

    expect(getDraft(store, "bot:one")).toBe("hello");
    expect(getDraftAttachments(store, "bot:one")).toEqual([paste, file]);
    expect(getDraft(store, "group:two")).toBe("room text");
    expect(getDraftAttachments(store, "group:two")).toEqual([]);
  });

  it("clears empty entries and ignores malformed stored attachments", () => {
    const store = memoryStore();
    setDraft(store, "bot:one", "hello");
    setDraft(store, "bot:one", "");
    store.setItem(
      "omb-draft-attachments",
      JSON.stringify({ "bot:one": [{ kind: "paste", id: "broken" }] }),
    );

    expect(getDraft(store, "bot:one")).toBe("");
    expect(getDraftAttachments(store, "bot:one")).toEqual([]);
  });
});
