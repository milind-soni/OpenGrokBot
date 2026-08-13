import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ArtifactPanel } from "./ArtifactPanel";

describe("ArtifactPanel", () => {
  it("renders the artifact in an opaque sandbox with workspace controls", () => {
    const html = renderToStaticMarkup(
      <ArtifactPanel
        artifact={{
          id: "message-1:0",
          messageId: "message-1",
          index: 0,
          language: "html",
          html: "<button>Interactive</button>",
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
    expect(html).toContain("External resources may connect to the network");
    expect(html).toContain("Refresh preview");
    expect(html).toContain("Copy HTML");
    expect(html).toContain("Download HTML");
    expect(html).toContain('role="separator"');
  });
});
