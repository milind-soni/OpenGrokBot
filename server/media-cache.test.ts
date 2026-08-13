import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createMediaCache, parseRange } from "./media-cache.ts";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "omb-media-cache-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("media cache", () => {
  it("stores validated image bytes behind an opaque cache key", async () => {
    const cache = createMediaCache({ rootDir: tempRoot() });
    const stored = await cache.store(
      { type: "base64", data: TINY_PNG_BASE64, mime: "image/png" },
      {
        threadId: "../../thread-1",
        messageId: "../../message-1",
        kind: "image",
        providerOrigin: new URL("http://127.0.0.1:11434"),
      },
    );

    expect(stored).toMatchObject({ mime: "image/png", bytes: 68 });
    expect(stored.cacheKey).toMatch(/^[0-9a-f-]+\.png$/);
    expect(stored.cacheKey).not.toContain("thread-1");
    expect(cache.resolve(stored.cacheKey)).toMatchObject({ mime: "image/png", bytes: 68 });
    expect(cache.resolve("../../config.json")).toBeNull();
  });

  it("rejects MIME mismatches and removes partial files", async () => {
    const root = tempRoot();
    const cache = createMediaCache({ rootDir: root });

    await expect(
      cache.store(
        { type: "base64", data: TINY_PNG_BASE64, mime: "image/jpeg" },
        {
          threadId: "thread-1",
          messageId: "message-1",
          kind: "image",
          providerOrigin: new URL("http://127.0.0.1:11434"),
        },
      ),
    ).rejects.toThrow(/does not match/i);

    expect(readdirSync(join(root, "objects"))).toEqual([]);
  });

  it("enforces the configured image limit", async () => {
    const cache = createMediaCache({ rootDir: tempRoot(), imageLimitBytes: 32 });

    await expect(
      cache.store(
        { type: "base64", data: TINY_PNG_BASE64, mime: "image/png" },
        {
          threadId: "thread-1",
          messageId: "message-1",
          kind: "image",
          providerOrigin: new URL("http://127.0.0.1:11434"),
        },
      ),
    ).rejects.toThrow(/25|32|limit/i);
  });

  it("uses ephemeral provider headers while downloading same-origin media", async () => {
    let authorization: string | null = null;
    const cache = createMediaCache({
      rootDir: tempRoot(),
      fetchImpl: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return new Response(Buffer.from(TINY_PNG_BASE64, "base64"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      },
    });

    const stored = await cache.store(
      {
        type: "url",
        url: "https://provider.example/generated/image.png",
        headers: { authorization: "Bearer short-lived-secret" },
      },
      {
        threadId: "thread-1",
        messageId: "message-1",
        kind: "image",
        providerOrigin: new URL("https://provider.example/v1"),
      },
    );

    expect(authorization).toBe("Bearer short-lived-secret");
    expect(stored).toMatchObject({ mime: "image/png", bytes: 68 });
  });

  it("removes stale partial files without deleting completed media", () => {
    const root = tempRoot();
    const objects = join(root, "objects");
    mkdirSync(objects, { recursive: true });
    const stale = join(objects, "stale.part");
    const fresh = join(objects, "fresh.part");
    const complete = join(objects, "kept.png");
    writeFileSync(stale, "partial");
    writeFileSync(fresh, "partial");
    writeFileSync(complete, "complete");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    utimesSync(stale, twoDaysAgo, twoDaysAgo);

    const cache = createMediaCache({ rootDir: root });
    expect(cache.removeStalePartials()).toBe(1);
    expect(readdirSync(objects).sort()).toEqual(["fresh.part", "kept.png"]);
  });
});

describe("HTTP byte ranges", () => {
  it("parses explicit, open-ended, and suffix byte ranges", () => {
    expect(parseRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange("bytes=7-", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
  });

  it("rejects malformed, multiple, and unsatisfiable ranges", () => {
    expect(parseRange("items=0-1", 10)).toBeNull();
    expect(parseRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(parseRange("bytes=12-15", 10)).toBeNull();
    expect(parseRange("bytes=8-2", 10)).toBeNull();
  });
});
