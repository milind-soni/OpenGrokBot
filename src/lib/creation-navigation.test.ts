import { describe, expect, it } from "vitest";

import type { CreationEntry } from "./creations";
import { artifactHeaderMode, creationOpenRequest, toggleArtifactSelection } from "./creation-navigation";

const entry: CreationEntry = {
  id: "m-1:0",
  kind: "html",
  botId: "bot-1",
  botName: "Maus",
  threadId: "thread-1",
  messageId: "m-1",
  createdAt: 1,
  title: "artifact-1.html",
  html: "<html><body>Secret payload</body></html>",
};

describe("creation navigation", () => {
  it("shows Close whenever an artifact workspace is open", () => {
    expect(artifactHeaderMode(undefined, null)).toBe("hidden");
    expect(artifactHeaderMode("latest", null)).toBe("open");
    expect(artifactHeaderMode("latest", "older")).toBe("close");
    expect(artifactHeaderMode("latest", "latest")).toBe("close");
  });
  it("closes the selected artifact or switches to the clicked artifact", () => {
    expect(toggleArtifactSelection("artifact-a", "artifact-a")).toBeNull();
    expect(toggleArtifactSelection("artifact-a", "artifact-b")).toBe("artifact-b");
    expect(toggleArtifactSelection(null, "artifact-a")).toBe("artifact-a");
  });
  it("builds a repeatable open request without copying creation payloads", () => {
    const first = creationOpenRequest(entry, "request-1");
    const second = creationOpenRequest(entry, "request-2");

    expect(first).toMatchObject({
      requestId: "request-1",
      botId: "bot-1",
      messageId: "m-1",
      creationId: "m-1:0",
      kind: "html",
    });
    expect(second.requestId).not.toBe(first.requestId);
    expect(JSON.stringify(first)).not.toContain("Secret payload");
    expect(JSON.stringify(first)).not.toContain("cacheKey");
  });
});
