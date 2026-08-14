// Model picker: exact instance/model routing for a bot's primary model or
// optional image/video specialists. Unknown-task models stay pickable for
// custom OpenAI-compatible servers whose catalog exposes only model IDs.
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { useStore, type Bot, type InstanceInfo, type ModelTask } from "@/state/store";
import { ProviderMark } from "./ProviderIcons";
import { cn } from "@/lib/cn";

function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  return instance?.models.options.find((option) => option.id === model)?.label ?? model;
}

function supportsTask(option: InstanceInfo["models"]["options"][number], role: ModelTask) {
  if (role === "chat") return !option.task || option.task === "chat";
  return !option.task || option.task === role;
}

export function ModelPicker({
  bot,
  role = "chat",
  className,
}: {
  bot: Bot;
  role?: ModelTask;
  className?: string;
}) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [railId, setRailId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const selection = role === "chat" ? bot.modelSelection : bot.specialists?.[role];
  const active = state.instances.find((instance) => instance.instanceId === selection?.instanceId);
  const eligible = useMemo(
    () => state.instances.filter((instance) => instance.models.options.some((option) => supportsTask(option, role))),
    [role, state.instances],
  );
  const railInstance =
    eligible.find((instance) => instance.instanceId === (railId ?? selection?.instanceId)) ?? eligible[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (instance: InstanceInfo, model: string) => {
    const next = { instanceId: instance.instanceId, model };
    if (role === "chat") dispatch({ type: "setModel", botId: bot.id, selection: next });
    else dispatch({
      type: "updateBot",
      botId: bot.id,
      patch: { specialists: { ...bot.specialists, [role]: next } },
    });
    setOpen(false);
  };

  const clear = () => {
    if (role === "chat") return;
    const specialists = { ...bot.specialists };
    delete specialists[role];
    dispatch({ type: "updateBot", botId: bot.id, patch: { specialists } });
    setOpen(false);
  };

  const placeholder = role === "chat" ? "Choose model" : `Auto (${role} off)`;
  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => {
          setRailId(selection?.instanceId ?? eligible[0]?.instanceId ?? null);
          setOpen((value) => !value);
        }}
        className="flex max-w-[210px] items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 py-1 pl-2 pr-2.5 text-[13px] text-ink hover:bg-raised"
        title={active && selection ? `${active.displayName} · ${modelLabel(active, selection.model)}` : placeholder}
      >
        {active && <ProviderMark driverKind={active.driverKind} size={14} />}
        <span className="truncate">{selection ? modelLabel(active, selection.model) : placeholder}</span>
        <ChevronDown size={14} className="shrink-0 text-ink-secondary" />
      </button>

      {open && (
        <div
          data-model-picker-content
          className="absolute right-0 top-full z-30 mt-2 flex w-[340px] overflow-hidden rounded-xl border border-hairline/50 bg-card shadow-2xl shadow-black/50"
        >
          <div className="flex flex-col gap-1 border-r border-hairline/40 bg-panel p-2">
            {eligible.map((instance) => {
              const unavailable = instance.snapshot.state !== "available";
              return (
                <button
                  type="button"
                  key={instance.instanceId}
                  onClick={() => setRailId(instance.instanceId)}
                  title={unavailable ? `${instance.displayName} — ${instance.snapshot.reason ?? "unavailable"}` : instance.displayName}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-lg",
                    instance.instanceId === railInstance?.instanceId ? "bg-raised" : "hover:bg-raised/60",
                    unavailable && "opacity-40",
                  )}
                >
                  <ProviderMark driverKind={instance.driverKind} size={18} />
                </button>
              );
            })}
          </div>

          <div className="min-w-0 flex-1 p-2">
            {role !== "chat" && selection && (
              <button
                type="button"
                onClick={clear}
                className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink-secondary hover:bg-raised/60 hover:text-ink"
              >
                <X size={14} /> Use primary chat instead
              </button>
            )}
            {railInstance ? (
              <>
                <div className="px-2 pb-1 pt-1">
                  <div className="text-[13px] font-semibold text-ink">{railInstance.displayName}</div>
                  <div className="truncate text-[11px] text-ink-secondary">
                    {railInstance.snapshot.state === "available"
                      ? (railInstance.snapshot.version ?? "ready")
                      : (railInstance.snapshot.reason ?? "unavailable")}
                  </div>
                </div>
                {railInstance.models.options.filter((option) => supportsTask(option, role)).map((option) => {
                  const current = selection?.instanceId === railInstance.instanceId && selection.model === option.id;
                  const disabled = railInstance.snapshot.state !== "available";
                  return (
                    <button
                      type="button"
                      key={option.id}
                      disabled={disabled}
                      onClick={() => pick(railInstance, option.id)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]",
                        disabled ? "cursor-not-allowed text-ink-secondary/50" : "text-ink hover:bg-raised/60",
                        current && "bg-raised",
                      )}
                    >
                      <span className="min-w-0 truncate">{option.label}</span>
                      {current && <Check size={14} className="shrink-0 text-accent" />}
                    </button>
                  );
                })}
              </>
            ) : (
              <div className="px-2 py-3 text-[13px] text-ink-secondary">No matching provider models found.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
