// One-place setup and lifecycle for the shared, isolated Local VM.
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Circle,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { Card, CommandLine } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";

type Action = "pull" | "run" | "start" | "stop" | "remove" | "recreate";

interface Status {
  platform: string;
  runtime: string | null;
  available: string[];
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  image_ref: string;
  base_image_ref: string;
  driver_version: string;
  container_name: string;
  workspace_path: string;
  workspace_guest_path: string;
  viewer_url: string;
  idle_timeout_ms: number;
  commands: {
    install: string | null;
    runtimeStart: string | null;
    pull: string | null;
    run: string | null;
    start: string | null;
    stop: string | null;
    remove: string | null;
    view: string;
  };
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]",
          done ? "bg-success/20 text-success" : "border border-hairline/50 text-ink-secondary",
        )}
      >
        {done ? <Check size={12} /> : n}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn("text-[14px]", done ? "text-ink-secondary line-through" : "text-ink")}>{title}</div>
        {!done && children && <div className="mt-2 flex flex-col items-start gap-2">{children}</div>}
      </div>
    </div>
  );
}

function ActionButton({
  action,
  pending,
  children,
  onClick,
  danger = false,
}: {
  action: Action;
  pending: Action | null;
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={pending !== null}
      className={cn(
        "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-50",
        danger ? "bg-danger/15 text-danger hover:bg-danger/20" : "bg-accent text-white hover:brightness-110",
      )}
    >
      {pending === action && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

export function LocalComputerSection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/local-computer", { signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Status request failed (${response.status})`);
    setStatus(body as Status);
    setError(null);
  }, []);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      controller = new AbortController();
      try {
        await refresh(controller.signal);
      } catch (e) {
        if (active && !(e instanceof DOMException && e.name === "AbortError")) {
          setStatus(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (active) {
          setLoading(false);
          timer = window.setTimeout(() => void poll(), 5000);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh, refreshKey]);

  const post = async (action: Exclude<Action, "recreate">) => {
    const response = await fetch(`/api/local-computer/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `${action} failed`);
    setStatus(body as Status);
  };

  const act = async (action: Action) => {
    if (
      action === "remove" &&
      !window.confirm("Delete the Local VM? Files and browser sign-ins in its durable workspace will remain.")
    ) return;
    if (
      action === "recreate" &&
      !window.confirm("Replace the existing Local VM with the pinned image and safety limits? Files and browser sign-ins in its durable workspace will remain.")
    ) return;
    setPending(action);
    setError(null);
    try {
      if (action === "recreate") {
        await post("remove");
        await post("run");
      } else {
        await post(action);
      }
      // The desktop starts after the container process; keep the progress
      // state honest and let the regular poll mark it Ready a few seconds on.
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  const c = status?.commands;
  const ready = status?.ready === true;
  const existing = status?.container !== "missing";
  const needsRecreate = Boolean(
    existing &&
      (status?.container === "stopped" ||
        !status?.imageMatches ||
        !status?.managed ||
        status?.network === "unsafe" ||
        status?.security === "unsafe" ||
        status?.persistence === "unsafe"),
  );
  const unavailable = !loading && !status;
  const host = status?.platform === "darwin" ? "Mac" : "computer";

  return (
    <>
      <Card
        title="Local VM"
        subtitle={`A shared Cua Linux sandbox on this ${host} for bots to browse and work in — isolated, backed by one durable workspace, and automatically recycled after 8 hours without activity.`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px]",
              ready ? "bg-success/15 text-success" : "bg-raised text-ink-secondary",
            )}
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : ready ? <Check size={12} /> : <Circle size={9} />}
            {loading ? "Checking…" : unavailable ? "Status unavailable" : ready ? "Ready" : (status?.problem ?? "Not ready")}
          </span>
          <button
            onClick={() => {
              setLoading(true);
              setRefreshKey((key) => key + 1);
            }}
            disabled={loading || pending !== null}
            className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
          >
            <RefreshCw size={12} /> Re-check
          </button>
          {ready && (
            <a
              href={status?.viewer_url ?? c?.view}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink hover:bg-raised"
            >
              <ExternalLink size={12} /> Watch screen
            </a>
          )}
        </div>
        {error && <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
      </Card>

      <Card title="Setup" subtitle="Once a container runtime is open, OpenMausBot prepares Cua and the VM for you.">
        <div className="flex flex-col gap-4">
          <Step n={1} title="Install a container runtime" done={Boolean(status?.runtime)}>
            <div className="text-[13px] leading-relaxed text-ink-secondary">
              Podman and Colima are free. Docker Desktop may require a paid licence for larger companies and government use.
            </div>
            {c?.install ? (
              <CommandLine command={c.install} />
            ) : (
              <a href="https://podman.io/docs/installation" target="_blank" rel="noreferrer" className="text-[13px] text-accent hover:underline">
                Open the Podman installation guide
              </a>
            )}
          </Step>

          <Step
            n={2}
            title={status?.runtime && !status.daemonUp ? `Open and start ${status.runtime}` : "Start the container runtime"}
            done={Boolean(status?.daemonUp)}
          >
            {!status?.runtime ? null : c?.runtimeStart ? (
              <CommandLine command={c.runtimeStart} />
            ) : (
              <div className="text-[13px] text-ink-secondary">Open the installed runtime and start its engine, then re-check.</div>
            )}
          </Step>

          <Step n={3} title="Prepare the Cua desktop (one-time download and build)" done={Boolean(status?.image)}>
            {status?.daemonUp && (
              <ActionButton action="pull" pending={pending} onClick={() => void act("pull")}>Prepare Cua desktop</ActionButton>
            )}
            {c?.pull && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">Show base-image download</summary><div className="mt-2"><CommandLine command={c.pull} /></div></details>}
          </Step>

          <Step n={4} title={needsRecreate ? "Replace the older or unsafe VM" : "Create and start the Local VM"} done={ready}>
            {needsRecreate ? (
              <>
                <div className="flex gap-2 text-[13px] text-warning">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  <span>{status?.problem}</span>
                </div>
                {status?.image ? (
                  <ActionButton action="recreate" pending={pending} onClick={() => void act("recreate")} danger>
                    <RotateCcw size={13} /> Delete and recreate
                  </ActionButton>
                ) : (
                  <div className="text-[13px] text-ink-secondary">Prepare the pinned Cua desktop above before replacing this VM.</div>
                )}
              </>
            ) : status?.container === "stopped" ? (
              <ActionButton action="start" pending={pending} onClick={() => void act("start")}>Start Local VM</ActionButton>
            ) : status?.container === "running" ? (
              <div className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={13} className="animate-spin" /> Waiting for the desktop…</div>
            ) : status?.image ? (
              <ActionButton action="run" pending={pending} onClick={() => void act("run")}>Create Local VM</ActionButton>
            ) : null}
            {c?.run && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">Show command</summary><div className="mt-2"><CommandLine command={c.run} /></div></details>}
          </Step>
        </div>
      </Card>

      {unavailable && (
        <Card>
          <div className="flex gap-2 text-[13px] text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>OpenMausBot could not inspect the container runtime. Re-check, or review the app logs.</span>
          </div>
        </Card>
      )}

      <Card
        title="Safety and storage"
        subtitle={`Cua Driver operates only the VM's desktop. Exactly one private host folder is mounted at ${status?.workspace_guest_path ?? "/home/cua/workspace"}; files and browser profiles there survive VM replacement, while everything elsewhere in the VM remains disposable. The password-protected viewer is available only on this machine. Docker and Podman runs are limited to 4 GB memory, 2 CPUs and 512 processes; all Linux capabilities are dropped except the two the desktop supervisor needs to switch to its unprivileged user. The VM can still reach the internet, and bots share it one at a time.`}
      >
        {existing && (
          <div className="flex flex-wrap gap-2">
            {status?.container === "running" && (
              <ActionButton action="stop" pending={pending} onClick={() => void act("stop")}>
                <Square size={12} /> Stop
              </ActionButton>
            )}
            <ActionButton action="remove" pending={pending} onClick={() => void act("remove")} danger>
              <Trash2 size={12} /> Delete VM
            </ActionButton>
          </div>
        )}
        <div className="mt-3 break-all text-[11px] text-ink-secondary">
          Durable workspace: {status?.workspace_path ?? "not created"} ·{" "}
          Cua Driver: {status?.driver_version ?? "0.20.0"} · Local image: {status?.image_ref ?? "not prepared"}
          {status?.base_image_ref ? <> · Base: {status.base_image_ref}</> : null}
        </div>
      </Card>
    </>
  );
}
