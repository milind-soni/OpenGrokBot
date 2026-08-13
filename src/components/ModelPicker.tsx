// Model picker v2 — "pick a brain" as a proper surface, not a mini menu.
// A named provider rail (brand mark, status dot, model count) beside a
// searchable model list; search flips to cross-provider results so any
// model is two keystrokes away. Routing is still by exact instanceId only,
// and unavailable instances render disabled with the reason, never hidden.
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, CircleAlert, Search, Sparkles } from "lucide-react";
import { useStore, type Bot, type InstanceInfo } from "@/state/store";
import { ProviderMark } from "./ProviderIcons";
import { cn } from "@/lib/cn";

function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  return instance?.models.options.find((o) => o.id === model)?.label ?? model;
}

/** Availability as one glanceable dot. */
function StatusDot({ instance, className }: { instance: InstanceInfo; className?: string }) {
  const ok = instance.snapshot.state === "available";
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        ok ? "bg-success" : "bg-ink-secondary/40",
        className,
      )}
    />
  );
}

interface Row {
  instance: InstanceInfo;
  option: { id: string; label: string };
}

export function ModelPicker({ bot, className }: { bot: Bot; className?: string }) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [railId, setRailId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selection = bot.modelSelection;
  const active = state.instances.find((i) => i.instanceId === selection.instanceId);
  const railInstance =
    state.instances.find((i) => i.instanceId === (railId ?? selection.instanceId)) ??
    state.instances[0];

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    const t = setTimeout(() => searchRef.current?.focus(), 10);
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (instance: InstanceInfo, model: string) => {
    dispatch({ type: "setModel", botId: bot.id, selection: { instanceId: instance.instanceId, model } });
    setOpen(false);
  };

  // rows currently shown: the rail provider's models, or search hits
  // across every provider (provider name + model label + ids all match)
  const searching = query.trim().length > 0;
  const rows = useMemo<Row[]>(() => {
    if (!searching) {
      return (railInstance?.models.options ?? []).map((option) => ({ instance: railInstance!, option }));
    }
    const q = query.trim().toLowerCase();
    return state.instances.flatMap((instance) =>
      instance.models.options
        .filter(
          (o) =>
            o.label.toLowerCase().includes(q) ||
            o.id.toLowerCase().includes(q) ||
            instance.displayName.toLowerCase().includes(q) ||
            instance.instanceId.toLowerCase().includes(q),
        )
        .map((option) => ({ instance, option })),
    );
  }, [searching, query, railInstance, state.instances]);

  useEffect(() => setCursor(0), [query, railId]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[cursor];
      if (row && row.instance.snapshot.state === "available") pick(row.instance, row.option.id);
    } else if (e.key === "Tab" && !searching) {
      // Tab walks the provider rail without leaving the keyboard
      e.preventDefault();
      const idx = state.instances.findIndex((i) => i.instanceId === railInstance?.instanceId);
      const next = state.instances[(idx + (e.shiftKey ? -1 : 1) + state.instances.length) % state.instances.length];
      if (next) setRailId(next.instanceId);
    }
  };

  const availableCount = state.instances.filter((i) => i.snapshot.state === "available").length;
  const modelCount = state.instances.reduce((n, i) => n + i.models.options.length, 0);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        onClick={() => {
          setRailId(selection.instanceId);
          setOpen((o) => !o);
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
          className="animate-pop-in absolute right-0 top-full z-30 mt-2 w-[460px] overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-2xl shadow-black/60"
        >
          {/* Search across every provider */}
          <div className="flex items-center gap-2 border-b border-hairline/40 px-3.5 py-2.5">
            <Search size={15} className="shrink-0 text-ink-secondary" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              placeholder="Search models and providers…"
              className="w-full bg-transparent text-[13.5px] text-ink placeholder:text-ink-secondary/60 focus:outline-none"
            />
            {!searching && (
              <kbd className="shrink-0 rounded border border-hairline/60 bg-inset px-1.5 py-0.5 text-[10px] text-ink-secondary">
                tab
              </kbd>
            )}
          </div>

          <div className="flex max-h-[380px]">
            {/* Provider rail: mark + name + status + model count */}
            {!searching && (
              <div className="flex w-[168px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-hairline/40 bg-panel p-1.5">
                {state.instances.map((instance) => {
                  const unavailable = instance.snapshot.state !== "available";
                  const onRail = instance.instanceId === railInstance?.instanceId;
                  const isActive = instance.instanceId === selection.instanceId;
                  return (
                    <button
                      key={instance.instanceId}
                      onClick={() => setRailId(instance.instanceId)}
                      title={
                        unavailable
                          ? `${instance.displayName} — ${instance.snapshot.reason ?? "unavailable"}`
                          : instance.displayName
                      }
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left",
                        onRail ? "bg-raised" : "hover:bg-raised/60",
                        unavailable && "opacity-45",
                      )}
                    >
                      <ProviderMark driverKind={instance.driverKind} size={17} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium text-ink">
                            {instance.displayName}
                          </span>
                          <StatusDot instance={instance} />
                        </span>
                        <span className="block truncate text-[10.5px] text-ink-secondary">
                          {instance.models.options.length} model{instance.models.options.length === 1 ? "" : "s"}
                          {isActive && " · in use"}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Model list (rail provider, or cross-provider search hits) */}
            <div ref={listRef} className="min-w-0 flex-1 overflow-y-auto p-1.5">
              {!searching && railInstance && (
                <div className="flex items-start justify-between gap-2 px-2.5 pb-1.5 pt-1.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-[13.5px] font-semibold text-ink">
                      {railInstance.displayName}
                      {railInstance.snapshot.authenticated === false &&
                        railInstance.snapshot.state === "available" && (
                          <span title="Not signed in">
                            <CircleAlert size={12} className="text-warning" />
                          </span>
                        )}
                    </div>
                    <div className="truncate text-[11px] text-ink-secondary">
                      {railInstance.snapshot.state === "available"
                        ? (railInstance.snapshot.version ?? "ready")
                        : (railInstance.snapshot.reason ?? "unavailable")}
                    </div>
                  </div>
                </div>
              )}
              {rows.length === 0 && (
                <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">
                  {searching ? `Nothing matches "${query}"` : "No providers — is the server running?"}
                </div>
              )}
              {rows.map(({ instance, option }, i) => {
                const current = selection.instanceId === instance.instanceId && selection.model === option.id;
                const disabled = instance.snapshot.state !== "available";
                return (
                  <button
                    key={`${instance.instanceId}/${option.id}`}
                    data-row={i}
                    disabled={disabled}
                    onClick={() => pick(instance, option.id)}
                    onMouseMove={() => setCursor(i)}
                    title={disabled ? (instance.snapshot.reason ?? "unavailable") : option.id}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left",
                      disabled ? "cursor-not-allowed opacity-45" : "hover:bg-raised/60",
                      (current || (searching && i === cursor)) && "bg-raised",
                      !searching && i === cursor && "bg-raised/60",
                    )}
                  >
                    {searching && <ProviderMark driverKind={instance.driverKind} size={14} />}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className={cn("truncate text-[13px]", disabled ? "text-ink-secondary" : "text-ink")}>
                          {option.label}
                        </span>
                        {option.id === instance.models.default && (
                          <span className="flex shrink-0 items-center gap-0.5 rounded bg-inset px-1 py-px text-[9.5px] font-medium uppercase tracking-wide text-ink-secondary">
                            <Sparkles size={8} /> default
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[10.5px] text-ink-secondary/80">
                        {searching ? `${instance.displayName} · ${option.id}` : option.id}
                      </span>
                    </span>
                    {current && <Check size={15} className="shrink-0 text-accent" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Fleet footer */}
          <div className="flex items-center justify-between border-t border-hairline/40 bg-inset/50 px-3.5 py-2 text-[11px] text-ink-secondary">
            <span>
              {availableCount} of {state.instances.length} providers ready · {modelCount} models
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-hairline/60 bg-inset px-1 py-px text-[10px]">↑↓</kbd>
              <kbd className="rounded border border-hairline/60 bg-inset px-1 py-px text-[10px]">↵</kbd>
              switch instantly
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
