import { describe, expect, it, vi } from "vitest";

import {
  BOT_DIRECTORY_API_URL,
  fetchBotDirectory,
  matchDirectoryBots,
  parseBotDirectory,
  type DirectoryBot,
} from "./bot-directory.ts";
import type { ProjectProfile } from "./project-scout.ts";

const entry = (over: Partial<Record<string, unknown>> = {}) => ({
  slug: "release-scribe",
  name: "Release Scribe",
  category: "Docs",
  integrations: ["GitHub"],
  prompt: "Set up a bot that drafts release notes.",
  detailUrl: "https://botdirectory.ai/bots/release-scribe/",
  ...over,
});

describe("parseBotDirectory", () => {
  it("accepts the published shape and keeps only the fields we use", () => {
    const bots = parseBotDirectory({ version: 1, bots: [entry({ contributor: "someone", addedAt: "2026" })] });
    expect(bots).toEqual([
      {
        slug: "release-scribe",
        name: "Release Scribe",
        category: "Docs",
        integrations: ["GitHub"],
        prompt: "Set up a bot that drafts release notes.",
        detailUrl: "https://botdirectory.ai/bots/release-scribe/",
      },
    ]);
  });

  it("drops malformed entries instead of failing the whole directory", () => {
    const bots = parseBotDirectory({
      version: 1,
      bots: [
        entry(),
        entry({ slug: "UPPER CASE" }),
        entry({ slug: "no-prompt", prompt: "" }),
        entry({ slug: "elsewhere", detailUrl: "https://evil.example/bots/x/" }),
        entry(), // duplicate slug
        "not an object",
      ],
    });
    expect(bots.map((bot) => bot.slug)).toEqual(["release-scribe"]);
  });

  it("rejects a response that is not the directory", () => {
    expect(() => parseBotDirectory({ version: 2, bots: [] })).toThrow("not supported");
    expect(() => parseBotDirectory([])).toThrow("not supported");
  });
});

describe("fetchBotDirectory", () => {
  it("fetches, validates, and passes errors through", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ version: 1, bots: [entry()] })));
    await expect(fetchBotDirectory(ok as unknown as typeof fetch)).resolves.toHaveLength(1);
    expect(ok).toHaveBeenCalledWith(BOT_DIRECTORY_API_URL, expect.objectContaining({ redirect: "error" }));

    const down = vi.fn(async () => new Response("nope", { status: 503 }));
    await expect(fetchBotDirectory(down as unknown as typeof fetch)).rejects.toThrow("HTTP 503");
  });
});

describe("matchDirectoryBots", () => {
  const profile: ProjectProfile = {
    name: "Shop",
    summary: "A storefront with payments.",
    stacks: ["TypeScript", "React"],
    signals: [{ role: "frontend", evidence: ["react"] }],
  };
  const bots: DirectoryBot[] = [
    { ...entry(), slug: "react-reviewer", name: "React Reviewer", category: "Engineering", integrations: ["GitHub"] } as DirectoryBot,
    { ...entry(), slug: "payments-auditor", name: "Payments Auditor", category: "Finance", integrations: ["Stripe"] } as DirectoryBot,
    { ...entry(), slug: "gig-closer", name: "Gig Closer", category: "Ops", integrations: ["QuickBooks"] } as DirectoryBot,
  ];

  it("returns only bots that overlap the profile, best match first, with the matched terms", () => {
    const matched = matchDirectoryBots(profile, bots);
    expect(matched.map((bot) => bot.slug)).toEqual(["react-reviewer", "payments-auditor"]);
    expect(matched[0]!.matched).toContain("react");
    expect(matched[1]!.matched).toContain("payments");
  });

  it("honors the limit", () => {
    expect(matchDirectoryBots(profile, bots, 1)).toHaveLength(1);
  });
});
