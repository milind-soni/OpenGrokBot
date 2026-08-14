import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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
  it("stores validated bytes behind an opaque key", async () => {
    const cache = createMediaCache({ rootDir: tempRoot() });
    const stored = await cache.store(
      { type: "base64", data: TINY_PNG_BASE64, mime: "image/png" },
      { kind: "image" },
    );

    expect(stored).toMatchObject({ mime: "image/png", bytes: 68 });
    expect(stored.cacheKey).toMatch(/^[0-9a-f-]+\.png$/);
    expect(cache.resolve(stored.cacheKey)).toMatchObject({ mime: "image/png", bytes: 68 });
    expect(cache.resolve("../../config.json")).toBeNull();
  });

  it("rejects model-authored remote URLs instead of exposing an SSRF surface", async () => {
    const root = tempRoot();
    const cache = createMediaCache({ rootDir: root });
    await expect(
      cache.store(
        { type: "url", url: "http://[::ffff:127.0.0.1]/admin" } as never,
        { kind: "image" },
      ),
    ).rejects.toThrow(/remote media URLs are not accepted/i);
    expect(readdirSync(join(root, "objects"))).toEqual([]);
  });

  it("rejects MIME mismatches and enforces byte limits", async () => {
    const root = tempRoot();
    const cache = createMediaCache({ rootDir: root, imageLimitBytes: 32 });
    await expect(
      cache.store(
        { type: "base64", data: TINY_PNG_BASE64, mime: "image/jpeg" },
        { kind: "image" },
      ),
    ).rejects.toThrow(/limit|does not match/i);
    expect(readdirSync(join(root, "objects"))).toEqual([]);
  });
});

describe("HTTP byte ranges", () => {
  it("parses explicit, open-ended, and suffix ranges", () => {
    expect(parseRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange("bytes=7-", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
  });

  it("rejects malformed or unsatisfiable ranges", () => {
    expect(parseRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(parseRange("bytes=12-15", 10)).toBeNull();
    expect(parseRange("bytes=8-2", 10)).toBeNull();
  });
});
