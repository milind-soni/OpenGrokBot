// The inspector's data: what a thread's turn actually looked like on the
// wire. Nothing new is captured here — the harness already tees two logs
// per thread, and this just reads them back:
//
//   events/<threadId>.ndjson  — the normalized RuntimeEvent stream the bus
//                               publishes (server/harness/bus.ts)
//   native/<threadId>.ndjson  — the provider's own protocol messages,
//                               verbatim and secret-redacted
//                               (server/drivers/native.ts)
//
// Merged by timestamp so a tool call and the raw message behind it sit
// next to each other. Newest-`limit` only: a long-lived thread has
// thousands of native lines and the panel wants the recent ones first.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type InspectorEntry =
  | { kind: "runtime"; at: string; data: unknown }
  | { kind: "native"; at: string; data: unknown };

export interface InspectorPage {
  entries: InspectorEntry[];
  /** line counts before the cap, so the UI can say "showing 200 of 1,687" */
  total: { runtime: number; native: number };
}

const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 2000;

/** Thread ids are uuids the harness minted; anything else is not a file we
 * should be reading. */
function assertThreadId(threadId: string) {
  if (!/^[\w-]+$/.test(threadId)) throw new Error("invalid thread id");
}

function readLines(file: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      // a torn last line during a write, or a hand-edited file — the rest
      // of the log is still worth showing
    }
  }
  return out;
}

const timeOf = (value: unknown, key: "createdAt" | "at"): string => {
  const record = value as Record<string, unknown> | null;
  const at = record?.[key];
  return typeof at === "string" ? at : "";
};

export function readThreadEvents(input: {
  eventsDir: string;
  nativeDir: string;
  threadId: string;
  limit?: number;
}): InspectorPage {
  const { eventsDir, nativeDir, threadId } = input;
  assertThreadId(threadId);
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

  const runtime = readLines(join(eventsDir, `${threadId}.ndjson`));
  const native = readLines(join(nativeDir, `${threadId}.ndjson`));

  // cap each log on its own, then merge: the native tee is several times
  // chattier than the runtime stream, and one shared cap would leave the
  // Events lens with a handful of rows behind hundreds of raw ones
  const merged: InspectorEntry[] = [
    ...runtime.slice(-limit).map((data): InspectorEntry => ({ kind: "runtime", at: timeOf(data, "createdAt"), data })),
    ...native.slice(-limit).map((data): InspectorEntry => ({ kind: "native", at: timeOf(data, "at"), data })),
  ];
  // stable sort: ties keep file order, which is emit order
  merged.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return {
    entries: merged,
    total: { runtime: runtime.length, native: native.length },
  };
}
