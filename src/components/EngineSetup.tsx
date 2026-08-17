// Setup UI for an engine that isn't ready — shared by onboarding, the model
// picker, and the chat's "engine missing" card so all three say the same
// thing from the same data.
//
// Everything here is driven by the driver-declared install descriptor
// (server/contracts.ts EngineInstall), never by per-engine copy in the UI.
// An engine with no command for this platform shows its docs link instead of
// an instruction that cannot run there.
//
// Installing is only half the job: most CLIs then need an interactive
// sign-in, which is why the terminal is the destination rather than a
// background `npm install` the user never sees.
import { useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, TerminalSquare } from "lucide-react";
import type { EngineInstall, InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";

type Platform = "darwin" | "win32" | "linux";

function hostPlatform(): Platform {
  const p = window.ogb?.platform;
  if (p === "darwin" || p === "win32" || p === "linux") return p;
  // browser/dev shell — guess from the UA so the copy button still offers
  // something sensible, since there's no bridge to ask
  const ua = navigator.userAgent;
  if (ua.includes("Mac")) return "darwin";
  if (ua.includes("Win")) return "win32";
  return "linux";
}

/** The install command for this machine, or null when the engine has none
 * here (a GUI download, or a POSIX-only installer viewed on Windows). */
export function installCommandFor(install: EngineInstall | undefined): string | null {
  return install?.command?.[hostPlatform()] ?? null;
}

/** True when the engine is installed but not yet signed in — the state that
 * looks ready in the picker but still can't answer a message. */
export function needsSignIn(instance: InstanceInfo | undefined): boolean {
  return instance?.snapshot.state === "available" && instance.snapshot.authenticated === false;
}

function CommandRow({
  command,
  trailing,
  iconCopy = false,
}: {
  command: string;
  trailing?: ReactNode;
  /** Copy as an icon-only button — for rows where a text label would push
   * the trailing content off the edge. */
  iconCopy?: boolean;
}) {
  const [done, setDone] = useState<"copied" | "opened" | null>(null);
  const canOpen = Boolean(window.ogb?.openInstallTerminal);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setDone("copied");
      setTimeout(() => setDone(null), 2000);
    } catch {
      /* clipboard blocked — the command is on screen to select by hand */
    }
  };

  const openTerminal = async () => {
    // the bridge copies to the clipboard too, so a failed launch still
    // leaves the user able to paste
    const ok = await window.ogb!.openInstallTerminal!(command);
    setDone(ok ? "opened" : "copied");
    setTimeout(() => setDone(null), 2500);
  };

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <code className="block overflow-x-auto whitespace-nowrap rounded-md bg-app px-2 py-1.5 font-mono text-[11.5px] leading-relaxed text-ink [scrollbar-width:none]">
        {command}
      </code>
      <div className="flex items-center gap-1">
        {canOpen && (
          <button
            onClick={openTerminal}
            title="Copies the command and opens a terminal"
            className="flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-accent px-2 text-[11.5px] font-medium text-white hover:bg-accent-border"
          >
            <TerminalSquare size={12} /> Open Terminal
          </button>
        )}
        <button
          onClick={copy}
          title={iconCopy ? (done ? "Copied" : "Copy command") : undefined}
          className={cn(
            "flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md text-[11.5px]",
            iconCopy && canOpen ? "w-6 justify-center" : "px-2",
            canOpen
              ? "text-ink-secondary hover:bg-raised hover:text-ink"
              : "bg-raised font-medium text-ink hover:bg-raised-hover",
          )}
        >
          {done ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          {(!iconCopy || !canOpen) && (done ? "Copied" : "Copy")}
        </button>
        {trailing && <span className="ml-auto flex items-center">{trailing}</span>}
      </div>
    </div>
  );
}

export function EngineSetup({
  instance,
  className,
  compact = false,
}: {
  instance: InstanceInfo;
  className?: string;
  /** Tight variant for the model picker: no explanatory sentence (the
   * picker header already states the problem), docs link inline with the
   * actions, and the sign-in / Node caveats collapsed into one small line. */
  compact?: boolean;
}) {
  const install = instance.install;
  const command = installCommandFor(install);
  const signIn = install?.signInCommand;
  const signInOnly = needsSignIn(instance);

  // No install descriptor at all means this isn't something you install —
  // the Box cloud runner is configured with a token in settings, not a CLI.
  // Claiming it "isn't installed" would send the user hunting for a package
  // that doesn't exist, so defer to whatever the driver reported instead.
  if (!install) {
    return (
      <div className={cn("text-[12.5px] leading-relaxed text-ink-secondary", className)}>
        {instance.snapshot.reason ?? "Not available on this machine."}
      </div>
    );
  }

  if (compact) {
    const guide = install.docsUrl ? (
      <a
        href={install.docsUrl}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-1 whitespace-nowrap pl-1 pr-2 text-[11.5px] text-ink-secondary hover:text-ink"
      >
        Setup guide <ExternalLink size={11} />
      </a>
    ) : undefined;
    const hints: string[] = [];
    if (!signInOnly && signIn) hints.push(`then \`${signIn}\` to sign in`);
    if (!signInOnly && install.needsNode) hints.push("needs Node.js");
    const shown = signInOnly ? signIn : command;
    return (
      <div className={cn("text-[12px] leading-relaxed text-ink-secondary", className)}>
        {shown ? (
          <CommandRow command={shown} trailing={guide} iconCopy />
        ) : (
          <div className="mt-2 flex items-center justify-between gap-2 pl-2">
            <span className="text-[11.5px]">
              {signInOnly
                ? "Sign in through the provider, then reopen this menu."
                : "No one-line installer for this platform."}
            </span>
            {guide}
          </div>
        )}
        {hints.length > 0 && (
          <p className="mt-1.5 px-2 text-[11px] text-ink-secondary/70">
            {hints.join(" · ").replace(/^./, (c) => c.toUpperCase())}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={cn("text-[12.5px] leading-relaxed text-ink-secondary", className)}>
      {signInOnly ? (
        <>
          <p>
            {instance.displayName} is installed but not signed in yet. Run this once, then come back.
          </p>
          {signIn && <CommandRow command={signIn} />}
        </>
      ) : (
        <>
          {command ? (
            <>
              <p>
                {instance.displayName} isn&rsquo;t installed. Run this in a terminal
                {signIn ? `, then \`${signIn}\` to sign in` : ""}.
              </p>
              <CommandRow command={command} />
              {install?.needsNode && (
                <p className="mt-1.5 text-[11.5px] text-ink-secondary/70">
                  Needs Node.js — install it first if <code className="font-mono">npm</code> isn&rsquo;t
                  found.
                </p>
              )}
            </>
          ) : (
            <p>
              {instance.displayName} isn&rsquo;t installed, and has no one-line installer for this
              platform.
            </p>
          )}
        </>
      )}

      {install?.docsUrl && (
        <a
          href={install.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] text-accent hover:underline"
        >
          <ExternalLink size={12} /> Setup guide
        </a>
      )}
    </div>
  );
}
