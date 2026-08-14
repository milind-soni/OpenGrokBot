import { describe, expect, it } from "vitest";

import { detectMediaIntent, mediaPromptOptions } from "./media-intent.ts";

describe("automatic media routing", () => {
  it("routes explicit creation requests without hijacking ordinary discussion", () => {
    expect(detectMediaIntent("Make me an image of a copper robot")).toBe("image");
    expect(detectMediaIntent("Generate a five second video of ocean waves in 9:16")).toBe("video");
    expect(detectMediaIntent("How do image models work?")).toBeNull();
    expect(detectMediaIntent("Write code that processes video frames")).toBeNull();
  });

  it("extracts supported aspect ratio and numeric duration hints", () => {
    expect(mediaPromptOptions("make a 5 second vertical clip in 9:16")).toEqual({
      aspectRatio: "9:16",
      durationSeconds: 5,
    });
    expect(mediaPromptOptions("make a landscape image, 16:9")).toEqual({ aspectRatio: "16:9" });
  });
});
