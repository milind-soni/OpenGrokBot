import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { beginArtifactResize, ArtifactPanel } from "./ArtifactPanel";

describe("ArtifactPanel", () => {
  it("renders the artifact in an opaque, network-disabled sandbox", () => {
    const html = renderToStaticMarkup(
      <ArtifactPanel
        artifact={{
          id: "message-1:0",
          messageId: "message-1",
          index: 0,
          language: "html",
          html: "<button>Interactive</button>",
          sourceLine: 1,
        }}
        width={560}
        onWidthChange={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).not.toContain("allow-popups");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("Network access disabled");
    expect(html).toContain("Refresh preview");
    expect(html).toContain("Copy HTML");
    expect(html).toContain("Download HTML");
    expect(html).toContain('role="separator"');
  });

  it("captures resize input and cleans up move, up, and cancel listeners", () => {
    const listeners = new Map<string, Set<(event: { clientX: number }) => void>>();
    const listen = (type: "pointermove" | "pointerup" | "pointercancel", listener: (event: { clientX: number }) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
      return () => set.delete(listener);
    };
    const capture = vi.fn();
    const release = vi.fn();
    const onWidthChange = vi.fn();

    const finish = beginArtifactResize({
      startX: 600,
      startWidth: 500,
      maximumWidth: 700,
      capture,
      release,
      listen,
      onWidthChange,
    });
    expect(capture).toHaveBeenCalledTimes(1);
    for (const listener of listeners.get("pointermove") ?? []) listener({ clientX: 450 });
    expect(onWidthChange).toHaveBeenLastCalledWith(650);
    for (const listener of [...(listeners.get("pointercancel") ?? [])]) listener({ clientX: 450 });
    expect(release).toHaveBeenCalledTimes(1);
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
    finish();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
