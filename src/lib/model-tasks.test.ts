import { describe, expect, it } from "vitest";

import { formatModelTaskOverrides, modelSupportsTask, parseModelTaskOverrides } from "./model-tasks";

describe("model task overrides", () => {
  it("parses one explicit chat, image, or video task per line", () => {
    expect(
      parseModelTaskOverrides("stable-diffusion-xl=image\nwan-2.2 = video\nlocal-assistant=chat\n\n"),
    ).toEqual({
      tasks: {
        "stable-diffusion-xl": "image",
        "wan-2.2": "video",
        "local-assistant": "chat",
      },
      error: null,
    });
  });

  it("reports the first invalid line without returning a partial map", () => {
    expect(parseModelTaskOverrides("good=image\nbad=audio\nafter=video")).toEqual({
      tasks: {},
      error: "Line 2 must use model=chat, model=image, or model=video.",
    });
  });

  it("formats overrides deterministically for editing", () => {
    expect(formatModelTaskOverrides({ zeta: "video", alpha: "image" })).toBe("alpha=image\nzeta=video");
  });

  it("keeps legacy untagged models in the primary picker and specialists task-specific", () => {
    expect(modelSupportsTask(undefined, "chat")).toBe(true);
    expect(modelSupportsTask("chat", "chat")).toBe(true);
    expect(modelSupportsTask("image", "chat")).toBe(false);
    expect(modelSupportsTask("image", "image")).toBe(true);
    expect(modelSupportsTask(undefined, "image")).toBe(false);
    expect(modelSupportsTask("video", "video")).toBe(true);
  });
});
