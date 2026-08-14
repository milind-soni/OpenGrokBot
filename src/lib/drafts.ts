// Unsent composer text, kept per thread. The Composer is keyed by bot/room
// id, so switching threads unmounts it and its local text state dies with
// it. Drafts live in localStorage, so coming back to a bot — in this
// session or after a restart — finds what you were typing still there.
import { useCallback, useState, type SetStateAction } from "react";
import { isAttachment, type Attachment } from "./composer-attachments.js";

const KEY = "omb-drafts";
const ATTACHMENTS_KEY = "omb-draft-attachments";

type Values = Record<string, unknown>;
type Store = Pick<Storage, "getItem" | "setItem"> | undefined;

// Storage is best-effort: a full quota, a locked-down origin, or a garbled
// value must never cost a keystroke — every failure reads as "no drafts".
function read(store: Store, key: string): Values {
  try {
    const raw = store?.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Values) : {};
  } catch {
    return {};
  }
}

export function getDraft(store: Store, id: string): string {
  const text = read(store, KEY)[id];
  return typeof text === "string" ? text : "";
}

export function setDraft(store: Store, id: string, text: string): void {
  const drafts = read(store, KEY);
  // an emptied composer drops its entry rather than storing "" forever
  if (text) drafts[id] = text;
  else delete drafts[id];
  try {
    store?.setItem(KEY, JSON.stringify(drafts));
  } catch {
    /* quota / private mode — the draft just doesn't outlive the mount */
  }
}

export function getDraftAttachments(store: Store, id: string): Attachment[] {
  const attachments = read(store, ATTACHMENTS_KEY)[id];
  return Array.isArray(attachments) ? attachments.filter(isAttachment) : [];
}

export function setDraftAttachments(store: Store, id: string, attachments: Attachment[]): void {
  const drafts = read(store, ATTACHMENTS_KEY);
  if (attachments.length) drafts[id] = attachments;
  else delete drafts[id];
  try {
    store?.setItem(ATTACHMENTS_KEY, JSON.stringify(drafts));
  } catch {
    /* quota / private mode — attachments remain in component state */
  }
}

// Reaching for localStorage is itself a failure point: on an origin with
// storage blocked the getter throws, and `typeof` doesn't shield it.
function getStore(): Store {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** useState for the composer text, persisted under `id` (a bot or room). */
export function useDraft(id: string): [string, (next: string) => void] {
  const store = getStore();
  const [text, setText] = useState(() => getDraft(store, id));
  const set = useCallback(
    (next: string) => {
      setText(next);
      setDraft(store, id, next);
    },
    [store, id],
  );
  return [text, set];
}

/** A conversation's complete composer draft. Attachment storage is separate
 * from text so typing does not stringify a large pasted payload per keypress. */
export function useComposerDraft(
  id: string,
): [
  string,
  (next: string) => void,
  Attachment[],
  (next: SetStateAction<Attachment[]>) => void,
] {
  const store = getStore();
  const [text, setText] = useDraft(id);
  const [attachments, setAttachmentState] = useState(() => getDraftAttachments(store, id));
  const setAttachments = useCallback(
    (next: SetStateAction<Attachment[]>) => {
      setAttachmentState((previous) => {
        const value = typeof next === "function" ? next(previous) : next;
        setDraftAttachments(store, id, value);
        return value;
      });
    },
    [store, id],
  );
  return [text, setText, attachments, setAttachments];
}
