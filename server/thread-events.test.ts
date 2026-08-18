import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readThreadEvents } from "./thread-events.ts";

const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "omb-thread-events-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const line = (o: unknown) => JSON.stringify(o) + "\n";

describe("readThreadEvents", () => {
  it("returns an empty page when neither log exists", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    expect(readThreadEvents({ eventsDir, nativeDir, threadId: "t1" })).toEqual({
      entries: [],
      total: { runtime: 0, native: 0 },
    });
  });

  it("merges runtime and native lines by time, tagging their source", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(
      join(eventsDir, "t1.ndjson"),
      line({ eventId: "e1", type: "turn.started", threadId: "t1", createdAt: "2026-08-17T10:00:00.000Z" }) +
        line({ eventId: "e2", type: "turn.completed", threadId: "t1", createdAt: "2026-08-17T10:00:02.000Z", ok: true }),
    );
    writeFileSync(
      join(nativeDir, "t1.ndjson"),
      line({ at: "2026-08-17T10:00:01.000Z", dir: "out", source: "claude.sdk.message", msg: { type: "user" } }),
    );
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1" });
    expect(page.total).toEqual({ runtime: 2, native: 1 });
    expect(page.entries.map((e) => [e.kind, e.at])).toEqual([
      ["runtime", "2026-08-17T10:00:00.000Z"],
      ["native", "2026-08-17T10:00:01.000Z"],
      ["runtime", "2026-08-17T10:00:02.000Z"],
    ]);
    // each entry keeps its original record whole under `data`
    expect(page.entries[1]).toMatchObject({ kind: "native", data: { dir: "out", msg: { type: "user" } } });
    expect(page.entries[0]).toMatchObject({ kind: "runtime", data: { eventId: "e1" } });
  });

  it("caps each log to its most recent `limit` lines and reports what it skipped", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    let body = "";
    for (let i = 0; i < 10; i++) {
      body += line({ eventId: `e${i}`, type: "content.delta", threadId: "t1", createdAt: `2026-08-17T10:00:${String(i).padStart(2, "0")}.000Z` });
    }
    writeFileSync(join(eventsDir, "t1.ndjson"), body);
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 3 });
    expect(page.entries.map((e) => (e.data as { eventId: string }).eventId)).toEqual(["e7", "e8", "e9"]);
    expect(page.total.runtime).toBe(10);
  });

  it("skips a corrupt line rather than failing the whole read", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(
      join(eventsDir, "t1.ndjson"),
      line({ eventId: "e1", type: "turn.started", threadId: "t1", createdAt: "2026-08-17T10:00:00.000Z" }) +
        "{not json\n" +
        line({ eventId: "e2", type: "turn.completed", threadId: "t1", createdAt: "2026-08-17T10:00:02.000Z", ok: true }),
    );
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1" });
    expect(page.entries).toHaveLength(2);
    // `total` is the number of non-empty log lines; malformed records are
    // counted but deliberately absent from the returned entries.
    expect(page.total.runtime).toBe(3);
  });

  it("keeps walking backward when a corrupt tail record would otherwise consume the limit", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    const body = Array.from({ length: 20 }, (_, i) =>
      line({ eventId: `e${i}`, type: "content.delta", threadId: "t1", createdAt: `2026-08-17T10:00:${String(i).padStart(2, "0")}.000Z` }),
    ).join("");
    writeFileSync(join(eventsDir, "t1.ndjson"), body + "{broken}\n");
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 3 });
    expect(page.entries.map((e) => (e.data as { eventId: string }).eventId)).toEqual(["e17", "e18", "e19"]);
    expect(page.total.runtime).toBe(21);
  });

  it("normalizes non-finite and fractional limits at the helper boundary", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    writeFileSync(join(eventsDir, "t1.ndjson"), line({ eventId: "e1", createdAt: "1" }) + line({ eventId: "e2", createdAt: "2" }));
    expect(readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: Number.NaN }).entries).toHaveLength(2);
    expect(readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 1.9 }).entries).toHaveLength(1);
  });

  it("updates cached totals from appended bytes and preserves multibyte records across read chunks", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    const file = join(eventsDir, "t1.ndjson");
    writeFileSync(file, line({ eventId: "large", createdAt: "1", text: "🐭".repeat(40_000) }));
    expect(readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 2 }).total.runtime).toBe(1);

    appendFileSync(file, line({ eventId: "latest", createdAt: "2" }));
    const page = readThreadEvents({ eventsDir, nativeDir, threadId: "t1", limit: 2 });
    expect(page.total.runtime).toBe(2);
    expect(page.entries.map((entry) => (entry.data as { eventId: string }).eventId)).toEqual(["large", "latest"]);
    expect((page.entries[0]!.data as { text: string }).text.startsWith("🐭🐭")).toBe(true);
  });

  it("refuses a thread id that could escape the log directory", () => {
    const eventsDir = tmp();
    const nativeDir = tmp();
    expect(() => readThreadEvents({ eventsDir, nativeDir, threadId: "../bots" })).toThrow(/thread id/);
  });
});
