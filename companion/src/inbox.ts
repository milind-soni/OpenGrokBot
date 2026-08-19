// Files a paired phone drops onto this computer.
//
// The harness has no upload route. Desktop attachments are already-on-disk
// paths (`<attached-file path="…" />`); the agent opens them where it runs.
// A photo on a phone is not on this disk, so the sidecar writes it here and
// the phone sends that path as the message — the same shape every driver
// already knows, and no harness change.
//
// Lives under the sidecar's own directory, not ~/.openmausbot. The two
// processes do not share a layout; the agent still reads the file because
// the path we return is an ordinary absolute path on this machine.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { FILE_MODE } from "./state.ts";

/** Eight megabytes. A phone photo after JPEG compression fits; a raw
 * burst or a video does not, and this process should not hold one. */
export const MAX_INBOX_BYTES = 8 * 1024 * 1024;

export type StoredInboxFile = {
  path: string;
  name: string;
  size: number;
};

/** Where new files land. Read at call time so tests can point `OMB_COMPANION_DIR`
 * without reloading this module. */
export function inboxRoot(): string {
  const base = process.env.OMB_COMPANION_DIR ?? join(homedir(), ".openmausbot-companion");
  return join(base, "inbox");
}

/** A filename that cannot walk out of the inbox. Basename only, a short
 * allowlist of characters, no leading dots. Empty input becomes `file`. */
export function safeFilename(input: string): string {
  const base = basename(String(input ?? "")).replaceAll("\0", "");
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return (cleaned || "file").slice(0, 80);
}

/** Write `bytes` into the inbox and return the path the phone should send. */
export function storeInboxFile(
  bytes: Buffer,
  filename: string,
  root = inboxRoot(),
): StoredInboxFile {
  if (bytes.length === 0) throw new Error("empty file");
  if (bytes.length > MAX_INBOX_BYTES) throw new Error("body too large");

  const name = safeFilename(filename);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(root, 0o700);
  } catch {
    /* existing dir on a filesystem that will not chmod — the write still works */
  }

  const stored = `${Date.now()}-${randomBytes(4).toString("hex")}-${name}`;
  const path = join(root, stored);
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + sep)) {
    throw new Error("invalid filename");
  }

  writeFileSync(path, bytes, { mode: FILE_MODE });
  return { path, name, size: bytes.length };
}

/** Stored inbox names start with a digit (the timestamp). A leading dot is
 * a traversal or a hidden file and is not one of ours. */
const INBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Read a file the phone previously stored. Basename only, and only from
 * this inbox — a stolen token must not become a reader for the rest of the
 * disk. Missing or invalid names are `null`, not thrown. */
export function readInboxFile(
  filename: string,
  root = inboxRoot(),
): { bytes: Buffer; type: string } | null {
  if (filename !== basename(filename) || !INBOX_NAME.test(filename)) return null;
  const path = join(root, filename);
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + sep)) {
    return null;
  }
  let fd: number | undefined;
  try {
    // Open once, then fstat/read that descriptor. `lstat` then `readFile`
    // is two path lookups: a symlink swapped in between them would follow
    // out of the inbox. `O_NOFOLLOW` is POSIX; Windows does not expose it
    // (or exposes `0`), so a reparse point is refused with `lstat` first.
    // That is still a path check — not the same as no-follow open — but
    // following here would read outside the inbox.
    const noFollow = constants.O_NOFOLLOW;
    const hasNoFollow = typeof noFollow === "number" && noFollow !== 0;
    if (!hasNoFollow && lstatSync(path).isSymbolicLink()) return null;
    const flags = hasNoFollow ? constants.O_RDONLY | noFollow : constants.O_RDONLY;
    fd = openSync(path, flags);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_INBOX_BYTES) return null;
    // Read at most the size we just validated. `readFileSync(fd)` would
    // follow a concurrent append past MAX_INBOX_BYTES.
    const bytes = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return { bytes: offset === bytes.length ? bytes : bytes.subarray(0, offset), type: inboxType(filename) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

export function inboxType(filename: string): string {
  switch (filename.split(".").pop()?.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "heic":
    case "heif":
      return "image/heic";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}
