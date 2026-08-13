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
import type { OpenCreationRequest } from "@/lib/creation-navigation";

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
  kind: "text" | "options" | "activity" | "screen" | "media";
  text?: string;
  card?: OptionCardData;
  /** activity messages: tool name + outcome */
  tool?: { name: string; ok?: boolean };
  /** screen messages: a frame of the bot's computer (base64) */
  png?: string;
  mime?: string;
  media?: MediaOutput[];
  at: number;
  /** the message this one follows; null = thread root. Edited messages
   * share a parentId with the version they replace — that's a fork. */
  parentId?: string | null;
}

export type ModelTask = "chat" | "image" | "video";
export type MediaKind = "image" | "video";
export type MediaStatus = "queued" | "generating" | "downloading" | "ready" | "failed" | "cancelled";

export interface MediaOutput {
  id: string;
  kind: MediaKind;
  status: MediaStatus;
  mime?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  bytes?: number;
  progress?: number;
  cacheKey?: string;
  providerJobId?: string;
  error?: string;
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

/** GET /api/config — configured flags only; secrets are never echoed. */
export interface ConfigStatus {
  xai?: { configured: boolean };
  openrouter: { configured: boolean };
  ollamaCloud: { configured: boolean };
  openaiCompatible: {
    apiKeyConfigured: boolean;
    url: string;
    model: string;
    modelTasks: Record<string, ModelTask>;
    imagePath: string;
    videoPath: string;
  };
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
  models: {
    default: string;
    options: Array<{
      id: string;
      label: string;
      task?: ModelTask;
      inputModalities?: string[];
      outputModalities?: string[];
    }>;
  };
}

interface AppState {
  bots: Bot[];
  instances: InstanceInfo[];
  config: ConfigStatus | null;
  selectedId: string;
  settingsOpen: boolean;
  pluginsOpen: boolean;
  creationsOpen: boolean;
  openCreationRequest: OpenCreationRequest | null;
  computerOpen: boolean;
  appSettingsOpen: boolean;
  /** in-flight assistant text per threadId (content.delta fold) */
  streaming: Record<string, string>;
  /** in-flight extended-thinking text per threadId (reasoning_text fold) —
   * ephemeral: shown while the bot thinks, dropped when the turn settles */
  reasoning: Record<string, string>;
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
  | { type: "streamDelta"; threadId: string; delta: string; reasoning?: string }
  | { type: "streamClear"; threadId: string }
  | { type: "screenFrame"; botId: string; png: string; mime: string }
  | { type: "provisioning"; botId: string; on: boolean }
  | { type: "setModel"; botId: string; selection: ModelSelection }
  | { type: "interrupt"; botId: string }
  | { type: "connected"; value: boolean }
  | { type: "error"; message: string | null }
  | { type: "toggleSettings"; open?: boolean }
  | { type: "togglePlugins"; open?: boolean }
  | { type: "toggleCreations"; open?: boolean }
  | { type: "openCreation"; request: OpenCreationRequest }
  | { type: "toggleComputer"; open?: boolean }
  | { type: "toggleAppSettings"; open?: boolean }
  | {
      type: "updateBot";
      botId: string;
      patch: Partial<
        Pick<
          Bot,
          "name" | "title" | "description" | "notifications" | "computer" | "color" | "mascotExpression" | "pinned" | "hidden"
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
      const next = updateBot(state, bot.id, (b) => {
        if (b.messages.some((m) => m.id === action.message.id)) {
          return { ...b, activeLeafId: action.message.id };
        }
        let messages = [...b.messages, action.message];
        // base64 screen frames are big; a long computer-use session would
        // grow memory without bound. Keep the newest few frames' pixels and
        // strip the rest (the message row survives as a placeholder).
        if (action.message.kind === "screen") {
          const withPng = messages.filter((m) => m.kind === "screen" && m.png);
          const excess = withPng.length - MAX_KEPT_SCREEN_FRAMES;
          if (excess > 0) {
            const dropIds = new Set(withPng.slice(0, excess).map((m) => m.id));
            messages = messages.map((m) => (dropIds.has(m.id) ? { ...m, png: undefined } : m));
          }
        }
        return { ...b, messages, activeLeafId: action.message.id };
      });
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
        const { [action.threadId]: __, ...reasoningRest } = animated.reasoning;
        return { ...animated, streaming: rest, reasoning: reasoningRest };
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
    case "streamDelta": {
      const next = { ...state };
      if (action.delta) {
        next.streaming = {
          ...state.streaming,
          [action.threadId]: (state.streaming[action.threadId] ?? "") + action.delta,
        };
      }
      if (action.reasoning) {
        next.reasoning = {
          ...state.reasoning,
          [action.threadId]: (state.reasoning[action.threadId] ?? "") + action.reasoning,
        };
      }
      return next;
    }
    case "streamClear": {
      const { [action.threadId]: _, ...rest } = state.streaming;
      const { [action.threadId]: __, ...reasoningRest } = state.reasoning;
      return { ...state, streaming: rest, reasoning: reasoningRest };
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
        pluginsOpen: open ? false : state.pluginsOpen,
        creationsOpen: open ? false : state.creationsOpen,
      };
    }
    case "togglePlugins": {
      const open = action.open ?? !state.pluginsOpen;
      return { ...state, pluginsOpen: open, creationsOpen: open ? false : state.creationsOpen };
    }
    case "toggleCreations": {
      const open = action.open ?? !state.creationsOpen;
      return {
        ...state,
        creationsOpen: open,
        pluginsOpen: open ? false : state.pluginsOpen,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "openCreation":
      return updateBot(
        {
          ...state,
          selectedId: action.request.botId,
          creationsOpen: false,
          openCreationRequest: action.request,
        },
        action.request.botId,
        (bot) => ({ ...bot, unread: false }),
      );
    case "toggleComputer": {
      const open = action.open ?? !state.computerOpen;
      return {
        ...state,
        computerOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        creationsOpen: open ? false : state.creationsOpen,
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
        creationsOpen: open ? false : state.creationsOpen,
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
      const { [action.threadId]: __, ...reasoning } = state.reasoning;
      return updateBot({ ...state, streaming, reasoning }, bot.id, (b) => ({
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
      return state;
  }
}

/** Newest screen frames whose pixels stay in memory per thread. */
const MAX_KEPT_SCREEN_FRAMES = 8;

const initialState: AppState = {
  bots: [],
  instances: [],
  config: null,
  selectedId: "",
  settingsOpen: false,
  pluginsOpen: false,
  creationsOpen: false,
  openCreationRequest: null,
  computerOpen: false,
  appSettingsOpen: false,
  streaming: {},
  reasoning: {},
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
  // per-frame stream-delta batching (see the "runtime" SSE case)
  const deltaBuffer = useRef(new Map<string, { text: string; reasoning: string }>());
  const deltaFlush = useRef<number | null>(null);

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
          if (event.type === "content.delta") {
            // Batch token deltas per animation frame (t3code-style): a fast
            // stream dispatches once per frame instead of once per token, so
            // the app tree re-renders at most ~60x/s while streaming.
            const buf = deltaBuffer.current;
            const entry = buf.get(event.threadId) ?? { text: "", reasoning: "" };
            if (event.streamKind === "assistant_text") entry.text += event.delta;
            else if (event.streamKind === "reasoning_text") entry.reasoning += event.delta;
            buf.set(event.threadId, entry);
            if (deltaFlush.current === null) {
              deltaFlush.current = requestAnimationFrame(() => {
                deltaFlush.current = null;
                for (const [threadId, { text, reasoning }] of deltaBuffer.current) {
                  rawDispatch({ type: "streamDelta", threadId, delta: text, reasoning: reasoning || undefined });
                }
                deltaBuffer.current.clear();
              });
            }
          } else if (event.type === "turn.completed") {
            // flush any buffered tail before clearing so no tokens are lost
            if (deltaFlush.current !== null) {
              cancelAnimationFrame(deltaFlush.current);
              deltaFlush.current = null;
            }
            for (const [threadId, { text, reasoning }] of deltaBuffer.current) {
              rawDispatch({ type: "streamDelta", threadId, delta: text, reasoning: reasoning || undefined });
            }
            deltaBuffer.current.clear();
            rawDispatch({ type: "streamClear", threadId: event.threadId });
          }
          break;
        }
        case "screen":
          rawDispatch({ type: "screenFrame", botId: frame.botId, png: frame.png, mime: frame.mime ?? "image/png" });
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
            config: {
              xai: frame.xai,
              openrouter: frame.openrouter,
              ollamaCloud: frame.ollamaCloud,
              openaiCompatible: frame.openaiCompatible,
              composio: frame.composio,
              box: frame.box,
              profile: frame.profile,
            },
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
