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
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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
