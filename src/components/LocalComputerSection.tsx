// Setting up a computer your bots can use, on your own machine.
//
// Not a wall of instructions: it looks at what you actually have and only
// tells you the next thing to do. Each step reports its own state, so a
// half-finished setup is obvious instead of mysterious.
import { useEffect, useState } from "react";
import { AlertTriangle, Check, Circle, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Card, CommandLine } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";

interface Status {
  platform: string;
  runtime: string | null;
  available: string[];
  daemonUp: boolean;
  image: boolean;
  container: "running" | "stopped" | "missing";
  network: "loopback" | "unsafe" | "unknown";
  image_ref: string;
  container_name: string;
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

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children?: React.ReactNode;
}) {
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
        {!done && children && <div className="mt-2 flex flex-col gap-2">{children}</div>}
      </div>
    </div>
  );
}

export function LocalComputerSection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;

    const poll = async () => {
      controller = new AbortController();
      try {
        const response = await fetch("/api/local-computer", { signal: controller.signal });
        if (!response.ok) throw new Error(`status request failed: ${response.status}`);
        const next = (await response.json()) as Status;
        if (active) setStatus(next);
      } catch (error) {
        if (active && !(error instanceof DOMException && error.name === "AbortError")) setStatus(null);
      } finally {
        if (active) {
          setLoading(false);
          // Schedule after completion so a slow runtime probe never overlaps
          // the next one and piles up container processes.
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
  }, [refreshKey]);

  const c = status?.commands;
  const ready = status?.container === "running" && status.network === "loopback";
  const unsafe = status?.container !== "missing" && status?.network === "unsafe";
  const unavailable = !loading && !status;
  const host = status?.platform === "darwin" ? "Mac" : "computer";

  return (
    <>
      <Card
        title="A computer of its own"
        subtitle={`Prepare a Linux desktop on this ${host} — free, disposable, with no host folders mounted. Connecting bots to it will be enabled separately.`}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px]",
              ready ? "bg-success/15 text-success" : "bg-raised text-ink-secondary",
            )}
          >
            {loading ? (
              <Loader2 size={12} className="animate-spin" />
            ) : ready ? (
              <Check size={12} />
            ) : (
              <Circle size={9} />
            )}
            {loading ? "Checking…" : unavailable ? "Status unavailable" : ready ? "Ready" : "Not set up yet"}
          </span>
          <button
            onClick={() => {
              setLoading(true);
              setRefreshKey((key) => key + 1);
            }}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
          >
            <RefreshCw size={12} /> Re-check
          </button>
          {ready && (
            <a
              href={c?.view}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink hover:bg-raised"
            >
              <ExternalLink size={12} /> Watch the screen
            </a>
          )}
        </div>
      </Card>

      <Card title="Setup" subtitle="Run these in a terminal. This panel notices when each step is done.">
        <div className="flex flex-col gap-4">
          <Step n={1} title="Install a container runtime" done={Boolean(status?.runtime)}>
            <div className="text-[13px] leading-relaxed text-ink-secondary">
              Any of these works — we use whichever you already have. <b className="text-ink">Colima</b> and{" "}
              <b className="text-ink">Podman</b> are free for everyone; Docker Desktop needs a paid licence for
              companies with 250 or more people or at least $10M revenue, and for government use.
            </div>
            {c?.install ? (
              <CommandLine command={c.install} />
            ) : (
              <a
                href="https://podman.io/docs/installation"
                target="_blank"
                rel="noreferrer"
                className="text-[13px] text-accent hover:underline"
              >
                Open the Podman installation guide
              </a>
            )}
          </Step>

          <Step
            n={2}
            title={
              status?.runtime && !status.daemonUp
                ? `Start ${status.runtime} — it's installed but not running`
                : "Start the runtime"
            }
            done={Boolean(status?.daemonUp)}
          >
            {!status?.runtime ? null : c?.runtimeStart ? (
              <CommandLine command={c.runtimeStart} />
            ) : (
              <div className="text-[13px] text-ink-secondary">
                Open the installed runtime and start its engine, then re-check.
              </div>
            )}
          </Step>

          <Step n={3} title="Download the desktop image (about 1 GB, once)" done={Boolean(status?.image)}>
            {c?.pull && <CommandLine command={c.pull} />}
          </Step>

          <Step
            n={4}
            title={
              unsafe
                ? "Recreate the computer with local-only ports"
                : status?.container === "stopped"
                  ? "Start the computer again"
                  : "Start the computer"
            }
            done={ready}
          >
            {unsafe ? (
              <>
                <div className="text-[13px] text-warning">
                  The existing container publishes its desktop beyond this machine. Remove and recreate it
                  before using it.
                </div>
                {c?.remove && <CommandLine command={c.remove} />}
                {c?.run && <CommandLine command={c.run} />}
              </>
            ) : status?.container === "stopped" ? (
              c?.start && <CommandLine command={c.start} />
            ) : (
              c?.run && <CommandLine command={c.run} />
            )}
          </Step>
        </div>
      </Card>

      {status && !status.runtime && (
        <Card title="">
          <div className="flex gap-2 text-[13px] text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>
              No container runtime found on this machine yet. Complete step 1, then re-check to continue.
            </span>
          </div>
        </Card>
      )}

      {unavailable && (
        <Card>
          <div className="flex gap-2 text-[13px] text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>OpenMausBot could not inspect container runtimes. Re-check, or review the server logs.</span>
          </div>
        </Card>
      )}

      <Card
        title="What this is"
        subtitle={`The desktop image is ${status?.image_ref ?? "Anthropic's computer-use demo image"} — an MIT-licensed Linux desktop with a browser, a file manager and an editor, plus the tools a bot needs to see the screen and click. It runs as "${status?.container_name ?? "openmausbot-computer"}", and you can stop or delete it any time.`}
      >
        <div className="flex flex-col gap-2">
          {c?.stop && <CommandLine command={c.stop} />}
          {c?.remove && <CommandLine command={c.remove} />}
        </div>
      </Card>
    </>
  );
}
