// Server-backed store. The React app holds no transports of its own:
// it dispatches typed commands over HTTP and folds the one SSE event
// stream from the harness server into local state. The reducer stays
// pure; everything async lives in the wrapped dispatch + SSE fold.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import type { MausColor, MausMotion } from "@/lib/mascot";

export type { MausColor } from "@/lib/mascot";

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
}

export interface Message {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen";
  text?: string;
  card?: OptionCardData;
  /** activity messages: tool name + outcome */
  tool?: { name: string; ok?: boolean };
  /** screen messages: a frame of the bot's computer (base64) */
  png?: string;
  mime?: string;
  at: number;
  /** the message this one follows; null = thread root. Edited messages
   * share a parentId with the version they replace — that's a fork. */
  parentId?: string | null;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
}

export interface Bot {
  id: string;
  threadId: string;
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: MausColor;
  mascotExpression?: string | null;
  unread: boolean;
  busy?: boolean;
  modelSelection: ModelSelection;
  /** Where this bot's computer runs; unset = auto (cloud box if one exists, else local). */
  computer?: "cloud" | "local" | "off";
  /** Sidebar group; unset/null or an id with no matching section = ungrouped. */
  sectionId?: string | null;
  pinned?: boolean;
  hidden?: boolean;
  messages: Message[];
  /** leaf of the visible conversation branch (see visibleMessages) */
  activeLeafId?: string | null;
}

/** The visible conversation: walk parentId links from the active leaf back
 * to the root. Falls back to the flat list for pre-branching payloads. */
export function visibleMessages(bot: Bot): Message[] {
  const leafId = bot.activeLeafId;
  if (!leafId) return bot.messages;
  const byId = new Map(bot.messages.map((m) => [m.id, m]));
  if (!byId.has(leafId)) return bot.messages;
  const path: Message[] = [];
  let cur = byId.get(leafId);
  while (cur) {
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

/** All versions of a user message (itself + the forks that replaced it),
 * oldest first. Length 1 = never edited. */
export function messageVersions(bot: Bot, message: Message): Message[] {
  if (message.role !== "user" || message.kind !== "text") return [message];
  return bot.messages
    .filter(
      (m) => m.role === "user" && m.kind === "text" && (m.parentId ?? null) === (message.parentId ?? null),
    )
    .sort((a, b) => a.at - b.at);
}

/** A named, collapsible sidebar group. Membership lives on the bot. */
export interface Section {
  id: string;
  name: string;
  order: number;
  collapsed: boolean;
  createdAt: number;
}

/** GET /api/config — configured flags only; secrets are never echoed. */
export interface ConfigStatus {
  xai?: { configured: boolean };
  composio: { configured: boolean; apiKeyConfigured?: boolean };
  box: { configured: boolean };
  /** who's using the app — collected in onboarding, shown in the sidebar */
  profile?: { name: string; email: string };
}

/** One row of GET /api/instances — the model picker's data. */
export interface InstanceInfo {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    authenticated?: boolean;
    version?: string | null;
  };
  models: { default: string; options: Array<{ id: string; label: string }> };
}

interface AppState {
  bots: Bot[];
  sections: Section[];
  instances: InstanceInfo[];
  config: ConfigStatus | null;
  selectedId: string;
  /** live sidebar filter; empty = show everything */
  search: string;
  paletteOpen: boolean;
  settingsOpen: boolean;
  pluginsOpen: boolean;
  computerOpen: boolean;
  appSettingsOpen: boolean;
  /** in-flight assistant text per threadId (content.delta fold) */
  streaming: Record<string, string>;
  /** latest live frame of a bot's computer, per botId */
  screens: Record<string, { png: string; mime: string }>;
  /** bots whose cloud computer is being provisioned */
  provisioning: Record<string, boolean>;
  connected: boolean;
  error: string | null;
  mascotMotion: {
    botId: string;
    nonce: number;
    kind: Exclude<MausMotion, "none">;
  } | null;
}

type Action =
  | { type: "hydrate"; bots: Bot[] }
  | { type: "sections"; sections: Section[] }
  | { type: "search"; value: string }
  | { type: "togglePalette"; open?: boolean }
  | { type: "createSection"; name: string; botId?: string }
  | { type: "renameSection"; sectionId: string; name: string }
  | { type: "deleteSection"; sectionId: string }
  | { type: "toggleSection"; sectionId: string }
  | { type: "instances"; instances: InstanceInfo[] }
  | { type: "configStatus"; config: ConfigStatus }
  | { type: "select"; id: string }
  | { type: "send"; botId: string; text: string }
  | { type: "editMessage"; botId: string; messageId: string; text: string }
  | { type: "switchBranch"; botId: string; messageId: string }
  | { type: "threadActive"; threadId: string; activeLeafId: string }
  | { type: "answerCard"; botId: string; messageId: string; answer: string }
  | { type: "dismissCard"; botId: string; messageId: string }
  | { type: "newBot" }
  | { type: "botAdded"; bot: Bot }
  | { type: "deleteBot"; botId: string }
  | { type: "duplicateBot"; botId: string }
  | { type: "markUnread"; botId: string }
  | { type: "botPatched"; bot: Partial<Bot> & { id: string } }
  | { type: "messageAdded"; threadId: string; message: Message }
  | { type: "messagePatched"; threadId: string; message: Message }
  | { type: "streamDelta"; threadId: string; delta: string }
  | { type: "streamClear"; threadId: string }
  | { type: "screenFrame"; botId: string; png: string; mime: string }
  | { type: "provisioning"; botId: string; on: boolean }
  | { type: "setModel"; botId: string; selection: ModelSelection }
  | { type: "interrupt"; botId: string }
  | { type: "connected"; value: boolean }
  | { type: "error"; message: string | null }
  | { type: "toggleSettings"; open?: boolean }
  | { type: "togglePlugins"; open?: boolean }
  | { type: "toggleComputer"; open?: boolean }
  | { type: "toggleAppSettings"; open?: boolean }
  | {
      type: "updateBot";
      botId: string;
      patch: Partial<
        Pick<
          Bot,
          "name" | "title" | "description" | "notifications" | "computer" | "color" | "mascotExpression" | "pinned" | "hidden" | "sectionId"
        >
      >;
    };

function updateBot(state: AppState, botId: string, fn: (b: Bot) => Bot): AppState {
  return { ...state, bots: state.bots.map((b) => (b.id === botId ? fn(b) : b)) };
}

function withMascotMotion(
  state: AppState,
  botId: string,
  kind: Exclude<MausMotion, "none">,
): AppState {
  return {
    ...state,
    mascotMotion: {
      botId,
      nonce: (state.mascotMotion?.nonce ?? 0) + 1,
      kind,
    },
  };
}

function patchCard(state: AppState, botId: string, messageId: string, patch: Partial<OptionCardData>): AppState {
  return updateBot(state, botId, (b) => ({
    ...b,
    messages: b.messages.map((m) =>
      m.id === messageId && m.card ? { ...m, card: { ...m.card, ...patch } } : m,
    ),
  }));
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate": {
      const selectedId =
        action.bots.some((b) => b.id === state.selectedId) && state.selectedId
          ? state.selectedId
          : (action.bots[0]?.id ?? "");
      return { ...state, bots: action.bots, selectedId };
    }
    case "instances":
      return { ...state, instances: action.instances };
    case "sections":
      return { ...state, sections: action.sections };
    case "search":
      return { ...state, search: action.value };
    case "togglePalette":
      return { ...state, paletteOpen: action.open ?? !state.paletteOpen };
    case "toggleSection":
      // optimistic; the PATCH echoes back over SSE
      return {
        ...state,
        sections: state.sections.map((s) =>
          s.id === action.sectionId ? { ...s, collapsed: !s.collapsed } : s,
        ),
      };
    case "configStatus":
      return { ...state, config: action.config };
    case "select":
      return updateBot(
        withMascotMotion({ ...state, selectedId: action.id }, action.id, "switch"),
        action.id,
        (b) => ({ ...b, unread: false }),
      );
    // optimistic card settle; the server's message.patch confirms it later
    case "answerCard":
      return withMascotMotion(
        patchCard(state, action.botId, action.messageId, { answered: action.answer }),
        action.botId,
        "working",
      );
    case "dismissCard":
      return patchCard(state, action.botId, action.messageId, { dismissed: true });
    case "botAdded":
      return withMascotMotion({
        ...state,
        bots: [action.bot, ...state.bots],
        selectedId: action.bot.id,
      }, action.bot.id, "arrive");
    case "deleteBot": {
      const bots = state.bots.filter((b) => b.id !== action.botId);
      const selectedId =
        state.selectedId === action.botId ? (bots.find((b) => !b.hidden)?.id ?? bots[0]?.id ?? "") : state.selectedId;
      return { ...state, bots, selectedId };
    }
    case "markUnread":
      return updateBot(withMascotMotion(state, action.botId, "surprise"), action.botId, (b) => ({ ...b, unread: true }));
    case "botPatched": {
      const before = state.bots.find((b) => b.id === action.bot.id);
      const kind =
        action.bot.unread && !before?.unread
          ? "surprise"
          : action.bot.busy === true && !before?.busy
            ? "working"
            : action.bot.busy === false && before?.busy
              ? "celebrate"
              : null;
      const next = kind ? withMascotMotion(state, action.bot.id, kind) : state;
      return updateBot(next, action.bot.id, (b) => ({ ...b, ...action.bot, messages: b.messages }));
    }
    case "messageAdded": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      // every server-side append chains onto (and becomes) the active leaf
      const next = updateBot(state, bot.id, (b) =>
        b.messages.some((m) => m.id === action.message.id)
          ? { ...b, activeLeafId: action.message.id }
          : { ...b, messages: [...b.messages, action.message], activeLeafId: action.message.id },
      );
      const motion =
        action.message.kind === "options"
          ? "thinking"
          : action.message.kind === "activity"
            ? action.message.tool?.ok === false
              ? "failure"
              : action.message.tool?.ok === true
                ? "success"
                : "working"
            : action.message.role === "bot" && action.message.kind === "text"
              ? "blink"
              : null;
      const animated = motion ? withMascotMotion(next, bot.id, motion) : next;
      // a settled assistant bubble replaces the in-flight stream
      if (action.message.role === "bot" && action.message.kind === "text") {
        const { [action.threadId]: _, ...rest } = animated.streaming;
        return { ...animated, streaming: rest };
      }
      return animated;
    }
    case "messagePatched": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      const motion =
        action.message.kind === "activity"
          ? action.message.tool?.ok === false
            ? "failure"
            : action.message.tool?.ok === true
              ? "success"
              : "working"
          : null;
      const next = motion ? withMascotMotion(state, bot.id, motion) : state;
      return updateBot(next, bot.id, (b) => ({
        ...b,
        messages: b.messages.map((m) => (m.id === action.message.id ? action.message : m)),
      }));
    }
    case "streamDelta":
      return {
        ...state,
        streaming: {
          ...state.streaming,
          [action.threadId]: (state.streaming[action.threadId] ?? "") + action.delta,
        },
      };
    case "streamClear": {
      const { [action.threadId]: _, ...rest } = state.streaming;
      return { ...state, streaming: rest };
    }
    case "screenFrame":
      return {
        ...withMascotMotion(state, action.botId, "success"),
        screens: { ...state.screens, [action.botId]: { png: action.png, mime: action.mime } },
        provisioning: { ...state.provisioning, [action.botId]: false },
      };
    case "provisioning":
      return {
        ...(action.on ? withMascotMotion(state, action.botId, "launch") : state),
        provisioning: { ...state.provisioning, [action.botId]: action.on },
      };
    case "setModel":
      return updateBot(state, action.botId, (b) => ({ ...b, modelSelection: action.selection }));
    case "connected":
      return { ...state, connected: action.value };
    case "error":
      return {
        ...(action.message && state.selectedId
          ? withMascotMotion(state, state.selectedId, "alert")
          : state),
        error: action.message,
      };
    // bot settings, the computer panel, and app settings share the right slot
    case "toggleSettings": {
      const open = action.open ?? !state.settingsOpen;
      return {
        ...state,
        settingsOpen: open,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "togglePlugins":
      return { ...state, pluginsOpen: action.open ?? !state.pluginsOpen };
    case "toggleComputer": {
      const open = action.open ?? !state.computerOpen;
      return {
        ...state,
        computerOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "toggleAppSettings": {
      const open = action.open ?? !state.appSettingsOpen;
      return {
        ...state,
        appSettingsOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        pluginsOpen: open ? false : state.pluginsOpen,
      };
    }
    case "updateBot": {
      const mascotChanged =
        Object.prototype.hasOwnProperty.call(action.patch, "color") ||
        Object.prototype.hasOwnProperty.call(action.patch, "mascotExpression");
      const next = mascotChanged
        ? withMascotMotion(state, action.botId, "customize")
        : state;
      return updateBot(next, action.botId, (b) => ({ ...b, ...action.patch }));
    }
    case "threadActive": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      // a rewind also invalidates any half-streamed text from the old branch
      const { [action.threadId]: _, ...streaming } = state.streaming;
      return updateBot({ ...state, streaming }, bot.id, (b) => ({
        ...b,
        activeLeafId: action.activeLeafId,
      }));
    }
    // optimistic leaf move; the server's thread frame confirms it later
    case "switchBranch": {
      const bot = state.bots.find((b) => b.id === action.botId);
      if (!bot) return state;
      let cur = action.messageId;
      for (;;) {
        const children = bot.messages.filter((m) => m.parentId === cur);
        if (!children.length) break;
        cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
      }
      return updateBot(state, action.botId, (b) => ({ ...b, activeLeafId: cur }));
    }
    // handled entirely by the async wrapper
    case "send":
    case "editMessage":
      return withMascotMotion(state, action.botId, "working");
    case "newBot":
    case "duplicateBot":
    case "interrupt":
    case "createSection":
    case "renameSection":
    case "deleteSection":
      return state;
  }
}

const initialState: AppState = {
  bots: [],
  sections: [],
  instances: [],
  config: null,
  selectedId: "",
  search: "",
  paletteOpen: false,
  settingsOpen: false,
  pluginsOpen: false,
  computerOpen: false,
  appSettingsOpen: false,
  streaming: {},
  screens: {},
  provisioning: {},
  connected: false,
  error: null,
  mascotMotion: null,
};

// ── API client ─────────────────────────────────────────────────────────
export async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

const StoreContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
} | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // debounced PATCH per bot for text-field edits (name/title/description)
  const patchTimers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; patch: Record<string, unknown> }>());

  const dispatch = useMemo(() => {
    const showError = (e: unknown) => {
      rawDispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
      setTimeout(() => rawDispatch({ type: "error", message: null }), 6000);
    };
    // fire-and-forget card persistence; the route is optional server-side
    const persistCard = (botId: string, messageId: string, patch: Partial<OptionCardData>) => {
      fetch(`/api/bots/${botId}/cards/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {});
    };

    const wrapped: React.Dispatch<Action> = (action) => {
      rawDispatch(action);
      switch (action.type) {
        case "send":
          api(`/api/bots/${action.botId}/messages`, {
            method: "POST",
            body: JSON.stringify({ text: action.text }),
          }).catch(showError);
          break;
        case "editMessage":
          api(`/api/bots/${action.botId}/messages/${action.messageId}/edit`, {
            method: "POST",
            body: JSON.stringify({ text: action.text }),
          }).catch(showError);
          break;
        case "switchBranch":
          api(`/api/bots/${action.botId}/active-branch`, {
            method: "POST",
            body: JSON.stringify({ messageId: action.messageId }),
          }).catch(showError);
          break;
        case "answerCard": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const card = bot?.messages.find((m) => m.id === action.messageId)?.card;
          if (card?.requestId) {
            const behavior =
              action.answer === "Allow" ? "allow" : action.answer === "Deny" ? "deny" : "answer";
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({
                requestId: card.requestId,
                behavior,
                message: behavior === "answer" ? action.answer : undefined,
              }),
            }).catch(showError);
          } else {
            persistCard(action.botId, action.messageId, { answered: action.answer });
            api(`/api/bots/${action.botId}/messages`, {
              method: "POST",
              body: JSON.stringify({ text: action.answer }),
            }).catch(showError);
          }
          break;
        }
        case "dismissCard": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const card = bot?.messages.find((m) => m.id === action.messageId)?.card;
          if (card?.requestId) {
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({ requestId: card.requestId, behavior: "deny", message: "Dismissed by user." }),
            }).catch(() => {});
          } else {
            persistCard(action.botId, action.messageId, { dismissed: true });
          }
          break;
        }
        case "newBot":
          api("/api/bots", { method: "POST" })
            .then(({ bot }) => rawDispatch({ type: "botAdded", bot }))
            .catch(showError);
          break;
        case "duplicateBot": {
          const source = stateRef.current.bots.find((b) => b.id === action.botId);
          if (!source) break;
          api("/api/bots", { method: "POST" })
            .then(({ bot }) =>
              api(`/api/bots/${bot.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  name: `${source.name} copy`,
                  title: source.title,
                  description: source.description,
                  notifications: source.notifications,
                  modelSelection: source.modelSelection,
                  ...(source.computer ? { computer: source.computer } : {}),
                }),
              }).then(({ bot: patched }) =>
                rawDispatch({ type: "botAdded", bot: { ...bot, ...patched, messages: bot.messages } }),
              ),
            )
            .catch(showError);
          break;
        }
        case "deleteBot":
          api(`/api/bots/${action.botId}`, { method: "DELETE" }).catch(showError);
          break;
        case "markUnread":
          api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify({ unread: true }) }).catch(
            () => {},
          );
          break;
        case "select": {
          const bot = stateRef.current.bots.find((b) => b.id === action.id);
          if (bot?.unread) {
            api(`/api/bots/${action.id}`, { method: "PATCH", body: JSON.stringify({ unread: false }) }).catch(() => {});
          }
          break;
        }
        case "setModel":
          api(`/api/bots/${action.botId}`, {
            method: "PATCH",
            body: JSON.stringify({ modelSelection: action.selection }),
          }).catch(showError);
          break;
        case "interrupt":
          api(`/api/bots/${action.botId}/interrupt`, { method: "POST" }).catch(showError);
          break;
        case "createSection":
          api("/api/sections", { method: "POST", body: JSON.stringify({ name: action.name }) })
            .then(({ section }) => {
              // creating a section straight from a bot's menu files it there
              if (action.botId) {
                rawDispatch({ type: "botPatched", bot: { id: action.botId, sectionId: section.id } });
                return api(`/api/bots/${action.botId}`, {
                  method: "PATCH",
                  body: JSON.stringify({ sectionId: section.id }),
                });
              }
            })
            .catch(showError);
          break;
        case "renameSection":
          api(`/api/sections/${action.sectionId}`, {
            method: "PATCH",
            body: JSON.stringify({ name: action.name }),
          }).catch(showError);
          break;
        case "deleteSection":
          api(`/api/sections/${action.sectionId}`, { method: "DELETE" }).catch(showError);
          break;
        case "toggleSection": {
          const section = stateRef.current.sections.find((s) => s.id === action.sectionId);
          if (!section) break;
          api(`/api/sections/${action.sectionId}`, {
            method: "PATCH",
            body: JSON.stringify({ collapsed: !section.collapsed }),
          }).catch(showError);
          break;
        }
        case "updateBot": {
          const timers = patchTimers.current;
          const pending = timers.get(action.botId);
          const patch = { ...pending?.patch, ...action.patch };
          if (pending) clearTimeout(pending.timer);
          timers.set(action.botId, {
            patch,
            timer: setTimeout(() => {
              timers.delete(action.botId);
              api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify(patch) }).catch(showError);
            }, 400),
          });
          break;
        }
        default:
          break;
      }
    };
    return wrapped;
  }, []);

  // ── initial load + SSE fold ──────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const loadAll = () => {
      api("/api/bots")
        .then(({ bots }) => alive && rawDispatch({ type: "hydrate", bots }))
        .catch(() => {});
      api("/api/instances")
        .then(({ instances }) => alive && rawDispatch({ type: "instances", instances }))
        .catch(() => {});
      api("/api/sections")
        .then(({ sections }) => alive && rawDispatch({ type: "sections", sections }))
        .catch(() => {});
      api("/api/config")
        .then((config) => alive && rawDispatch({ type: "configStatus", config }))
        .catch(() => {});
    };
    loadAll();

    const es = new EventSource("/api/events");
    es.onopen = () => {
      rawDispatch({ type: "connected", value: true });
      loadAll(); // resync anything missed while disconnected
    };
    es.onerror = () => rawDispatch({ type: "connected", value: false });
    es.onmessage = (raw) => {
      let frame: any;
      try {
        frame = JSON.parse(raw.data);
      } catch {
        return;
      }
      switch (frame.kind) {
        case "message":
          rawDispatch({ type: "messageAdded", threadId: frame.threadId, message: frame.message });
          break;
        case "message.patch":
          rawDispatch({ type: "messagePatched", threadId: frame.threadId, message: frame.message });
          break;
        case "thread":
          rawDispatch({ type: "threadActive", threadId: frame.threadId, activeLeafId: frame.activeLeafId });
          break;
        case "bot": {
          const bot = frame.bot as Partial<Bot> & { id: string };
          // reading the selected chat clears its badge immediately
          if (bot.unread && bot.id === stateRef.current.selectedId) {
            bot.unread = false;
            fetch(`/api/bots/${bot.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ unread: false }),
            }).catch(() => {});
          }
          rawDispatch({ type: "botPatched", bot });
          break;
        }
        case "runtime": {
          const event = frame.event;
          if (event.type === "content.delta" && event.streamKind === "assistant_text") {
            rawDispatch({ type: "streamDelta", threadId: event.threadId, delta: event.delta });
          } else if (event.type === "turn.completed") {
            rawDispatch({ type: "streamClear", threadId: event.threadId });
          }
          break;
        }
        case "screen":
          rawDispatch({ type: "screenFrame", botId: frame.botId, png: frame.png, mime: frame.mime ?? "image/png" });
          break;
        case "sections":
          rawDispatch({
            type: "sections",
            sections: Array.isArray(frame.sections) ? frame.sections : [],
          });
          break;
        case "computer":
          rawDispatch({ type: "provisioning", botId: frame.botId, on: frame.state === "provisioning" });
          break;
        case "bot.deleted":
          rawDispatch({ type: "deleteBot", botId: frame.botId });
          break;
        // a key changed and the fleet hot-reloaded — refresh the picker so
        // newly available providers un-dim immediately
        case "config":
          rawDispatch({
            type: "configStatus",
            config: { xai: frame.xai, composio: frame.composio, box: frame.box, profile: frame.profile },
          });
          api("/api/instances")
            .then(({ instances }) => rawDispatch({ type: "instances", instances }))
            .catch(() => {});
          break;
      }
    };
    return () => {
      alive = false;
      es.close();
    };
  }, []);

  const value = useMemo(() => ({ state, dispatch }), [state, dispatch]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside provider");
  return ctx;
}

export function formatTime(at: number) {
  return new Date(at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
