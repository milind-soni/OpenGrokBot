// Model picker: an instance rail + model list, backed by /api/instances.
// Routing is by exact instanceId only — an entry is never inferred from a
// driver kind. Missing a cloud login does not grey an engine out: a local
// model on that CLI is still a valid pick, so every icon stays clickable
// and Custom is always at the bottom of the list. An instance that is
// genuinely unavailable renders disabled, with the reason in the open.
import { Fragment, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useStore, type Bot, type InstanceInfo } from "@/state/store";
import { ProviderMark } from "./ProviderIcons";
import { EngineSetup, needsSignIn } from "./EngineSetup";
import { cn } from "@/lib/cn";

/** Above this many models a flat list stops being usable. Claude, Codex, Grok
 *  and Kimi all sit well under it and render exactly as before. */
const SEARCH_THRESHOLD = 15;

function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  return instance?.models.options.find((o) => o.id === model)?.label ?? model;
}

export function ModelPicker({ bot, className }: { bot: Bot; className?: string }) {
  const { state, dispatch, refreshInstances } = useStore();
  const [open, setOpen] = useState(false);
  const [railId, setRailId] = useState<string | null>(null);
  const [pane, setPane] = useState<"main" | "custom">("main");
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const selection = bot.modelSelection;
  const active = state.instances.find((i) => i.instanceId === selection.instanceId);
  const railInstance =
    state.instances.find((i) => i.instanceId === (railId ?? selection.instanceId)) ??
    state.instances[0];

  // Opening the picker is the user asking "what can I run?" — re-probe rather
  // than answer from a snapshot taken at launch, which is stale the moment
  // they install or sign in to anything.
  useEffect(() => {
    if (open) void refreshInstances();
  }, [open, refreshInstances]);

  // A query left over from another engine, or from the last time the picker
  // was open, would silently hide most of the list.
  useEffect(() => setQuery(""), [open, railInstance?.instanceId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pane === "custom") setPane("main");
      else setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, pane]);

  const pick = (instance: InstanceInfo, model: string) => {
    // setModel replaces the whole selection, so a configured effort has to be
    // carried across deliberately. Same engine, different model: keep it —
    // silently resetting the level the user chose is not what "pick a model"
    // means. Different engine: drop it, since effort vocabularies are
    // per-driver and the old level may be one the new engine never declared.
    const sameInstance = instance.instanceId === selection.instanceId;
    dispatch({
      type: "setModel",
      botId: bot.id,
      selection: {
        instanceId: instance.instanceId,
        model,
        ...(sameInstance && selection.effort ? { effort: selection.effort } : {}),
      },
    });
    setOpen(false);
  };

  // OpenCode discovers hundreds of models from whatever providers the user has
  // configured, so a long catalog gets a filter and provider headers. A short
  // one renders exactly as it always has. The filter follows the pane in view,
  // because a discovered catalog lands in Custom and that is the pane that
  // actually gets long.
  const allOptions = railInstance?.models.options ?? [];
  const official = allOptions.filter((o) => !o.custom);
  const custom = allOptions.filter((o) => o.custom);
  const options = pane === "custom" ? custom : official;
  const customCurrent =
    selection.instanceId === railInstance?.instanceId && custom.some((o) => o.id === selection.model);
  const needle = query.trim().toLowerCase();
  const matches =
    options.length > SEARCH_THRESHOLD && needle
      ? options.filter((o) => o.label.toLowerCase().includes(needle) || o.id.toLowerCase().includes(needle))
      : options;
  const providerOf = (id: string) => (id.includes("/") ? id.slice(0, id.indexOf("/")) : "");
  // one provider means the header would say the same thing on every row
  const grouped = new Set(matches.map((o) => providerOf(o.id))).size > 1;

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        onClick={() => {
          setRailId(selection.instanceId);
          setOpen((o) => {
            const next = !o;
            if (next) {
              const inst = state.instances.find((i) => i.instanceId === selection.instanceId);
              const isCustom = inst?.models.options.some((opt) => opt.id === selection.model && opt.custom);
              setPane(isCustom ? "custom" : "main");
            }
            return next;
          });
        }}
        className="flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 py-1 pl-2 pr-2.5 text-[13px] text-ink hover:bg-raised"
        title={active ? `${active.displayName} · ${modelLabel(active, selection.model)}` : selection.model}
      >
        {active && <ProviderMark driverKind={active.driverKind} size={14} />}
        <span className="max-w-[160px] truncate">{modelLabel(active, selection.model)}</span>
        <ChevronDown size={14} className="text-ink-secondary" />
      </button>

      {open && (
        <div
          data-model-picker-content
          className="absolute right-0 top-full z-30 mt-2 flex max-h-[min(420px,calc(100dvh-8rem))] w-[320px] overflow-hidden rounded-xl border border-hairline/50 bg-card shadow-2xl shadow-black/50"
        >
          {/* instance rail */}
          <div className="flex flex-col gap-1 overflow-y-auto border-r border-hairline/40 bg-panel p-2">
            {state.instances.map((instance) => {
              const onRail = instance.instanceId === railInstance?.instanceId;
              return (
                <button
                  key={instance.instanceId}
                  onClick={() => {
                    setRailId(instance.instanceId);
                    setPane("main");
                  }}
                  title={instance.displayName}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-lg",
                    onRail ? "bg-raised" : "hover:bg-raised/60",
                  )}
                >
                  <ProviderMark driverKind={instance.driverKind} size={18} />
                </button>
              );
            })}
          </div>

          {/* model list for the rail-selected instance */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col p-2">
            {railInstance ? (
              <>
                <div className="shrink-0 px-2 pb-1 pt-1">
                  <div className="text-[13px] font-semibold text-ink">
                    {pane === "custom" ? "Custom" : railInstance.displayName}
                  </div>
                  <div className="truncate text-[11px] text-ink-secondary">
                    {pane === "custom"
                      ? "Inject a local model into this agent"
                      : (railInstance.snapshot.version ??
                        (railInstance.snapshot.state === "available"
                          ? "ready"
                          : (railInstance.snapshot.reason ?? "ready")))}
                  </div>
                </div>
                {/* Official-pane setup only. Custom is the inject list and
                    must stay visible even when the cloud CLI is unsigned
                    or the packaged app has not found it on PATH yet. */}
                {pane === "main" &&
                  (railInstance.snapshot.state !== "available" || needsSignIn(railInstance)) && (
                  <div className="shrink-0 border-b border-hairline/40 px-2 pb-2.5">
                    <EngineSetup instance={railInstance} />
                  </div>
                )}
                {options.length > SEARCH_THRESHOLD && (
                  <div className="relative px-2 pb-2 pt-1">
                    <Search
                      size={13}
                      className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-secondary"
                    />
                    <input
                      autoFocus
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={`Search ${options.length} models`}
                      className="w-full rounded-lg border border-hairline/40 bg-inset py-1 pl-7 pr-2 text-[13px] text-ink placeholder:text-ink-secondary/70 focus:border-hairline focus:outline-none"
                    />
                  </div>
                )}
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {pane === "custom" && (
                    <button
                      onClick={() => {
                        setPane("main");
                        setQuery("");
                      }}
                      className="mb-0.5 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink-secondary hover:bg-raised/60"
                    >
                      <ChevronLeft size={14} />
                      <span>Back</span>
                    </button>
                  )}
                  {matches.length === 0 && (
                    <div className="px-2 py-3 text-[13px] text-ink-secondary">
                      {/* An empty list is not a failed search. Every shadow
                          instance gets {default:"",options:[]} from the
                          registry, and so does opencode when discovery fails —
                          telling someone who never typed anything that nothing
                          matches their empty query is a non-sequitur, and it
                          points them at the search box instead of at the
                          EngineSetup card right above that can actually fix
                          it. An empty Custom pane is a third case: nothing is
                          broken, there is just no local runtime up yet. */}
                      {needle ? (
                        <>No model matches “{query}”.</>
                      ) : pane === "custom" ? (
                        "Start oMLX, Ollama, Unsloth, LM Studio, or EXO — live models show up here"
                      ) : (
                        "No models available."
                      )}
                    </div>
                  )}
                  {matches.map((option, i) => {
                    const provider = providerOf(option.id);
                    const header = grouped && provider !== providerOf(matches[i - 1]?.id ?? "") ? provider : null;
                    const current =
                      selection.instanceId === railInstance.instanceId && selection.model === option.id;
                    const disabled =
                      !option.custom &&
                      (railInstance.snapshot.state !== "available" || needsSignIn(railInstance));
                    return (
                      <Fragment key={option.id}>
                        {header && (
                          <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-secondary/70">
                            {header}
                          </div>
                        )}
                        <button
                          disabled={disabled}
                          onClick={() => pick(railInstance, option.id)}
                          title={option.id}
                          className={cn(
                            "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]",
                            disabled ? "cursor-not-allowed text-ink-secondary/50" : "text-ink hover:bg-raised/60",
                            current && "bg-raised",
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate">{option.label}</span>
                            {option.id === railInstance.models.default && (
                              <span className="shrink-0 rounded bg-inset px-1 py-px text-[10px] text-ink-secondary">
                                default
                              </span>
                            )}
                          </span>
                          {current && <Check size={14} className="shrink-0 text-accent" />}
                        </button>
                      </Fragment>
                    );
                  })}
                </div>
                {pane === "main" && (
                  <button
                    onClick={() => {
                      setPane("custom");
                      setQuery("");
                    }}
                    className={cn(
                      "mt-1 flex w-full shrink-0 items-center justify-between gap-2 border-t border-hairline/40 px-2 pb-0.5 pt-1.5 text-left text-[13px] text-ink hover:bg-raised/60",
                      customCurrent && "bg-raised",
                    )}
                  >
                    <span>
                      Custom
                      {custom.length > 0 && (
                        <span className="ml-1.5 text-[11px] text-ink-secondary">{custom.length}</span>
                      )}
                    </span>
                    <ChevronRight size={14} className="shrink-0 text-ink-secondary" />
                  </button>
                )}
              </>
            ) : (
              <div className="px-2 py-3 text-[13px] text-ink-secondary">
                No providers — is the server running?
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
