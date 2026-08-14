import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";

import type { MediaKind, MediaSource } from "./contracts.ts";

const DEFAULT_IMAGE_LIMIT = 25 * 1024 * 1024;
const DEFAULT_VIDEO_LIMIT = 512 * 1024 * 1024;

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

export interface StoredMedia {
  cacheKey: string;
  mime: string;
  bytes: number;
}

export interface ResolvedMedia extends StoredMedia {
  path: string;
}

export interface MediaCache {
  store(source: MediaSource, context: { kind: MediaKind; signal?: AbortSignal }): Promise<StoredMedia>;
  resolve(cacheKey: string): ResolvedMedia | null;
}

function detectedMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const ascii = Buffer.from(bytes.subarray(0, 32)).toString("ascii");
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && ascii.slice(4, 8) === "ftyp") return "video/mp4";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "video/webm";
  }
  return null;
}

function strictBase64(value: string): Buffer {
  const clean = value.replace(/\s/g, "");
  if (!clean || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) {
    throw new Error("generated media contains invalid base64 data");
  }
  return Buffer.from(clean, "base64");
}

function normalizedMime(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header || !Number.isSafeInteger(size) || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export function createMediaCache(options: {
  rootDir: string;
  imageLimitBytes?: number;
  videoLimitBytes?: number;
}): MediaCache {
  const objectsDir = join(options.rootDir, "objects");
  mkdirSync(objectsDir, { recursive: true });

  return {
    async store(source, context) {
      context.signal?.throwIfAborted();
      if (source.type !== "base64" && source.type !== "bytes") {
        throw new Error("remote media URLs are not accepted");
      }
      const data = source.type === "base64" ? strictBase64(source.data) : Buffer.from(source.data);
      const limit = context.kind === "image"
        ? (options.imageLimitBytes ?? DEFAULT_IMAGE_LIMIT)
        : (options.videoLimitBytes ?? DEFAULT_VIDEO_LIMIT);
      if (data.length > limit) throw new Error(`generated ${context.kind} exceeds the ${limit} byte cache limit`);
      const actual = detectedMime(data);
      if (!actual || !actual.startsWith(`${context.kind}/`)) {
        throw new Error(`generated ${context.kind} has an unsupported file signature`);
      }
      const claimed = normalizedMime(source.mime);
      if (claimed && claimed !== actual) {
        throw new Error(`generated media MIME ${claimed} does not match its ${actual} bytes`);
      }
      const extension = EXTENSION_BY_MIME[actual];
      if (!extension) throw new Error(`generated media type ${actual} is not supported`);
      const partialPath = join(objectsDir, `${crypto.randomUUID()}.part`);
      const cacheKey = `${crypto.randomUUID()}.${extension}`;
      try {
        writeFileSync(partialPath, data, { flag: "wx" });
        context.signal?.throwIfAborted();
        renameSync(partialPath, join(objectsDir, cacheKey));
      } catch (error) {
        try { unlinkSync(partialPath); } catch {}
        throw error;
      }
      return { cacheKey, mime: actual, bytes: data.length };
    },
    resolve(cacheKey) {
      if (basename(cacheKey) !== cacheKey || !/^[0-9a-f-]+\.(png|jpg|gif|webp|mp4|webm)$/.test(cacheKey)) return null;
      const path = resolve(objectsDir, cacheKey);
      if (!path.startsWith(resolve(objectsDir) + sep) || !existsSync(path)) return null;
      const extension = cacheKey.slice(cacheKey.lastIndexOf(".") + 1);
      const mime = MIME_BY_EXTENSION[extension];
      if (!mime) return null;
      const descriptor = openSync(path, "r");
      try {
        const head = Buffer.alloc(16);
        const length = readSync(descriptor, head, 0, head.length, 0);
        if (detectedMime(head.subarray(0, length)) !== mime) return null;
      } finally {
        closeSync(descriptor);
      }
      return { cacheKey, path, mime, bytes: statSync(path).size };
    },
  };
}
