import { lookup } from "node:dns/promises";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { isIP } from "node:net";
import { basename, join, resolve, sep } from "node:path";

import type { MediaKind, MediaSource } from "./contracts.ts";

const DEFAULT_IMAGE_LIMIT = 25 * 1024 * 1024;
const DEFAULT_VIDEO_LIMIT = 512 * 1024 * 1024;
const PARTIAL_MAX_AGE_MS = 24 * 60 * 60_000;

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};
const MIME_BY_EXTENSION = Object.fromEntries(
  Object.entries(EXTENSION_BY_MIME).map(([mime, extension]) => [extension, mime]),
);

export interface MediaCacheContext {
  threadId: string;
  messageId: string;
  kind: MediaKind;
  providerOrigin: URL;
}

export interface StoredMedia {
  cacheKey: string;
  mime: string;
  bytes: number;
}

export interface ResolvedMedia extends StoredMedia {
  path: string;
}

export interface MediaCache {
  store(source: MediaSource, context: MediaCacheContext): Promise<StoredMedia>;
  resolve(cacheKey: string): ResolvedMedia | null;
  removeStalePartials(): number;
}

export interface MediaCacheOptions {
  rootDir: string;
  imageLimitBytes?: number;
  videoLimitBytes?: number;
  fetchImpl?: typeof fetch;
}

function detectedMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const ascii = Buffer.from(bytes).toString("ascii");
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && ascii.slice(4, 8) === "ftyp") return "video/mp4";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "video/webm";
  }
  return null;
}

function normalizeMime(value: string | undefined): string | undefined {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mime && mime !== "application/octet-stream" ? mime : undefined;
}

function expectedKind(mime: string): MediaKind | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return null;
}

function isPrivateAddress(address: string): boolean {
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") return true;
  const normalized = address.toLowerCase();
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true;
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

async function assertSafeRemote(url: URL, providerOrigin: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("media URL must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("media URL must not contain credentials");
  if (url.origin === providerOrigin.origin) return;
  if (url.hostname === "localhost") throw new Error("media URL points to a private address");
  if (isIP(url.hostname)) {
    if (isPrivateAddress(url.hostname)) throw new Error("media URL points to a private address");
    return;
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("media URL points to a private address");
  }
}

function strictBase64(value: string): Buffer {
  const clean = value.replace(/\s/g, "");
  if (!clean || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) {
    throw new Error("generated media contains invalid base64 data");
  }
  return Buffer.from(clean, "base64");
}

export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header || !Number.isSafeInteger(size) || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return null;
  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startRaw);
  const requestedEnd = endRaw ? Number(endRaw) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export function createMediaCache(options: MediaCacheOptions): MediaCache {
  const objectsDir = join(options.rootDir, "objects");
  const fetchImpl = options.fetchImpl ?? fetch;
  mkdirSync(objectsDir, { recursive: true });

  const finalize = (
    partialPath: string,
    claimedMime: string | undefined,
    kind: MediaKind,
    bytes: number,
  ): StoredMedia => {
    const fd = openSync(partialPath, "r");
    const head = Buffer.alloc(Math.min(32, bytes));
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    const actual = detectedMime(head);
    if (!actual || expectedKind(actual) !== kind) throw new Error(`generated ${kind} has an unsupported file signature`);
    const normalizedClaim = normalizeMime(claimedMime);
    if (normalizedClaim && normalizedClaim !== actual) {
      throw new Error(`generated media MIME ${normalizedClaim} does not match its ${actual} bytes`);
    }
    const extension = EXTENSION_BY_MIME[actual];
    if (!extension) throw new Error(`generated media type ${actual} is not supported`);
    const cacheKey = `${crypto.randomUUID()}.${extension}`;
    renameSync(partialPath, join(objectsDir, cacheKey));
    return { cacheKey, mime: actual, bytes };
  };

  const writeBase64 = (source: Extract<MediaSource, { type: "base64" }>, context: MediaCacheContext) => {
    const data = strictBase64(source.data);
    const limit = context.kind === "image"
      ? (options.imageLimitBytes ?? DEFAULT_IMAGE_LIMIT)
      : (options.videoLimitBytes ?? DEFAULT_VIDEO_LIMIT);
    if (data.length > limit) throw new Error(`generated ${context.kind} exceeds the ${limit} byte cache limit`);
    const partialPath = join(objectsDir, `${crypto.randomUUID()}.part`);
    try {
      writeFileSync(partialPath, data, { flag: "wx" });
      return finalize(partialPath, source.mime, context.kind, data.length);
    } catch (error) {
      try {
        unlinkSync(partialPath);
      } catch {}
      throw error;
    }
  };

  const writeRemote = async (source: Extract<MediaSource, { type: "url" }>, context: MediaCacheContext) => {
    let current = new URL(source.url);
    const credentialOrigin = current.origin;
    let response: Response | null = null;
    for (let redirects = 0; redirects <= 3; redirects++) {
      await assertSafeRemote(current, context.providerOrigin);
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(120_000),
        headers: current.origin === credentialOrigin ? source.headers : undefined,
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error("generated media exceeded the redirect limit");
      current = new URL(location, current);
    }
    if (!response?.ok || !response.body) throw new Error(`generated media download failed with HTTP ${response?.status ?? 0}`);
    const limit = context.kind === "image"
      ? (options.imageLimitBytes ?? DEFAULT_IMAGE_LIMIT)
      : (options.videoLimitBytes ?? DEFAULT_VIDEO_LIMIT);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > limit) throw new Error(`generated ${context.kind} exceeds the ${limit} byte cache limit`);
    const partialPath = join(objectsDir, `${crypto.randomUUID()}.part`);
    const fd = openSync(partialPath, "wx");
    let bytes = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) throw new Error(`generated ${context.kind} exceeds the ${limit} byte cache limit`);
        writeSync(fd, value);
      }
      closeSync(fd);
      return finalize(partialPath, source.mime ?? response.headers.get("content-type") ?? undefined, context.kind, bytes);
    } catch (error) {
      try {
        closeSync(fd);
      } catch {}
      try {
        unlinkSync(partialPath);
      } catch {}
      throw error;
    }
  };

  return {
    store: (source, context) =>
      source.type === "base64" ? Promise.resolve().then(() => writeBase64(source, context)) : writeRemote(source, context),
    resolve: (cacheKey) => {
      if (basename(cacheKey) !== cacheKey || !/^[0-9a-f-]+\.(png|jpg|gif|webp|mp4|webm)$/.test(cacheKey)) return null;
      const path = resolve(objectsDir, cacheKey);
      if (!path.startsWith(resolve(objectsDir) + sep) || !existsSync(path)) return null;
      const extension = cacheKey.slice(cacheKey.lastIndexOf(".") + 1);
      const mime = MIME_BY_EXTENSION[extension];
      if (!mime) return null;
      return { cacheKey, path, mime, bytes: statSync(path).size };
    },
    removeStalePartials: () => {
      let removed = 0;
      const cutoff = Date.now() - PARTIAL_MAX_AGE_MS;
      for (const name of readdirSync(objectsDir)) {
        if (!name.endsWith(".part")) continue;
        const path = join(objectsDir, name);
        if (statSync(path).mtimeMs >= cutoff) continue;
        unlinkSync(path);
        removed++;
      }
      return removed;
    },
  };
}
