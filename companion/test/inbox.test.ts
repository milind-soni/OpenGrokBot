import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_INBOX_BYTES, readInboxFile, safeFilename, storeInboxFile } from "../src/inbox.ts";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const dir = () => (root = mkdtempSync(join(tmpdir(), "inbox-")));

describe("safeFilename", () => {
  it("keeps a plain name", () => {
    expect(safeFilename("notes.txt")).toBe("notes.txt");
  });

  it("strips directory components so a traversal cannot leave the inbox", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("foo/bar/photo.jpg")).toBe("photo.jpg");
  });

  it("replaces characters a path would treat specially", () => {
    expect(safeFilename("my photo (1).jpg")).toBe("my_photo_1_.jpg");
    expect(safeFilename("a\0b.png")).toBe("ab.png");
  });

  it("does not keep a leading dot, and empty input is still a name", () => {
    expect(safeFilename("")).toBe("file");
    expect(safeFilename("...")).toBe("file");
    expect(safeFilename(".hidden")).toBe("hidden");
  });

  it("caps a long name so the inbox path stays short", () => {
    expect(safeFilename("a".repeat(200)).length).toBe(80);
  });
});

describe("storeInboxFile", () => {
  it("writes the bytes and returns an absolute path inside the root", () => {
    const stored = storeInboxFile(Buffer.from("hello"), "notes.txt", dir());
    expect(stored.name).toBe("notes.txt");
    expect(stored.size).toBe(5);
    expect(stored.path.startsWith(root!)).toBe(true);
    expect(readFileSync(stored.path, "utf8")).toBe("hello");
  });

  it("refuses an empty body and a body over the ceiling", () => {
    expect(() => storeInboxFile(Buffer.alloc(0), "a.txt", dir())).toThrow(/empty/);
    expect(() => storeInboxFile(Buffer.alloc(MAX_INBOX_BYTES + 1), "a.bin", dir())).toThrow(
      /too large/,
    );
  });

  it("does not collide when the same name is stored twice", () => {
    const a = storeInboxFile(Buffer.from("one"), "same.txt", dir());
    const b = storeInboxFile(Buffer.from("two"), "same.txt", root!);
    expect(a.path).not.toBe(b.path);
    expect(readFileSync(a.path, "utf8")).toBe("one");
    expect(readFileSync(b.path, "utf8")).toBe("two");
  });

  it("reads a stored file back, and refuses a name that could leave the inbox", () => {
    const stored = storeInboxFile(Buffer.from("hello"), "notes.txt", dir());
    const got = readInboxFile(basename(stored.path), root!);
    expect(got?.bytes.toString("utf8")).toBe("hello");
    expect(got?.type).toBe("application/octet-stream");
    expect(readInboxFile("../notes.txt", root!)).toBeNull();
    expect(readInboxFile("..", root!)).toBeNull();
    expect(readInboxFile(".hidden", root!)).toBeNull();
    expect(readInboxFile("missing.txt", root!)).toBeNull();
  });
});
