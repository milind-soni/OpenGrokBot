import { describe, expect, it } from "vitest";
import {
  normalizeBrowserUrl,
  normalizeCrop,
  ObservationCoordinator,
  parseBrowserTargets,
  safeBrowserUrl,
} from "./computer-observation.ts";

describe("computer observation coordinator", () => {
  it("captures after actions but sends vision only for changed pixels", () => {
    const coordinator = new ObservationCoordinator();
    expect(coordinator.observeFrame("frame-a", null)).toMatchObject({ changed: true });
    coordinator.noteAction();
    expect(coordinator.observeFrame("frame-a", null)).toMatchObject({ changed: false });
    coordinator.noteAction();
    expect(coordinator.observeFrame("frame-b", { x: 20, y: 20, width: 100, height: 100 })).toMatchObject({ changed: true });
    coordinator.noteRetry();
    coordinator.noteStructuredObservation();
    coordinator.noteVerification(true);
    coordinator.noteVerification(false);
    expect(coordinator.metrics).toEqual({
      screenshotsCaptured: 3,
      screenshotsSentToModel: 2,
      fullScreenObservations: 1,
      croppedObservations: 1,
      structuredBrowserObservations: 1,
      computerActions: 2,
      retries: 1,
      verificationSuccesses: 1,
      verificationFailures: 1,
    });
  });

  it("accepts bounded crop regions and rejects width or height overflow", () => {
    expect(normalizeCrop({ x: 10, y: 20, width: 200, height: 100 }, 1280, 720)).toEqual({
      x: 10,
      y: 20,
      width: 200,
      height: 100,
    });
    expect(normalizeCrop({ x: -1, y: 0, width: 200, height: 100 }, 1280, 720)).toBeNull();
    expect(normalizeCrop({ x: 0, y: 0, width: 31, height: 100 }, 1280, 720)).toBeNull();
    expect(normalizeCrop({ x: 0, y: 0, width: 100, height: 31 }, 1280, 720)).toBeNull();
    expect(normalizeCrop({ x: 0, y: 0, width: "wide", height: 100 }, 1280, 720)).toBeNull();
    expect(normalizeCrop({ x: 1200, y: 0, width: 200, height: 100 }, 1280, 720)).toBeNull();
    expect(normalizeCrop({ x: 0, y: 700, width: 100, height: 50 }, 1280, 720)).toBeNull();
  });

  it("redacts exposed URLs but preserves full navigation state internally", () => {
    const raw = "https://user:password@example.com/a?token=secret#fragment";
    expect(safeBrowserUrl(raw)).toBe("https://example.com/a");
    expect(normalizeBrowserUrl(raw)).toBe("https://example.com/a?token=secret#fragment");
    expect(safeBrowserUrl(`https://example.com/${"a".repeat(2_048)}`)).toBeNull();
    expect(parseBrowserTargets(JSON.stringify([
      { id: "one", type: "page", title: " Example page ", url: raw },
      { id: "two", type: "service_worker", url: "https://example.com/worker" },
    ]))).toEqual([
      {
        id: "one",
        title: "Example page",
        url: "https://example.com/a",
        comparisonUrl: "https://example.com/a?token=secret#fragment",
      },
    ]);
  });
});
