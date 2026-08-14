// A containerized computer that can later be connected to a bot.
//
// The cloud box needs a paid plan, and the "This Mac" path points an agent
// at the desktop the human is using. A container sits between them: free,
// disposable, and isolated from the user's files — and it runs the same
// X11 desktop our computer tools already speak (xdotool + scrot), so the
// tool layer can be reused when the selection wiring lands. This module only
// prepares and inspects that environment; it does not connect a bot to it.
//
// This module is deliberately read-only. It reports what is installed and
// never installs anything on someone's machine.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { augmentedPath } from "./env-path.ts";

const run = promisify(execFile);

export type CommandRunner = (
  command: string,
  args: string[],
  timeout?: number,
) => Promise<{ stdout: string }>;

/** The desktop image. Anthropic's computer-use demo image is the one whose
 * toolchain matches our shell exactly — it ships xdotool, scrot and
 * imagemagick — and it is MIT, with an arm64 build as well as x86. */
export const IMAGE = "ghcr.io/anthropics/anthropic-quickstarts:computer-use-demo-latest";
export const CONTAINER = "openmausbot-computer";

/** Runtimes we can drive, best-known first. Docker is listed because most
 * people already have it, NOT because we recommend installing it: its
 * licence requires payment at 250 employees or $10M revenue, and for
 * every government user. We adapt to whatever is already there. */
const RUNTIMES = ["docker", "podman", "container"] as const;
export type Runtime = (typeof RUNTIMES)[number];

async function sh(cmd: string, args: string[], timeout = 8000): Promise<{ stdout: string }> {
  const { stdout } = await run(cmd, args, {
    timeout,
    encoding: "utf8",
    env: { ...process.env, PATH: augmentedPath() },
  });
  return { stdout };
}

async function installed(
  cmd: string,
  runner: CommandRunner,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    await runner(platform === "win32" ? "where.exe" : "/usr/bin/which", [cmd], 4000);
    return true;
  } catch {
    return false;
  }
}

export interface ContainerComputerStatus {
  platform: NodeJS.Platform;
  /** the runtime we will use, or null when none is installed */
  runtime: Runtime | null;
  /** everything we found, so the UI can say which one it picked */
  available: Runtime[];
  /** installed is not the same as running */
  daemonUp: boolean;
  image: boolean;
  container: "running" | "stopped" | "missing";
  /** Whether every published port is loopback-only and both desktop ports exist. */
  network: "loopback" | "unsafe" | "unknown";
  image_ref: string;
  container_name: string;
}

export async function containerComputerStatus(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
): Promise<ContainerComputerStatus> {
  // Apple's `container` CLI is macOS-only. Ignoring an unrelated executable
  // with that generic name on other platforms avoids false detection.
  const candidates = RUNTIMES.filter((runtime) => runtime !== "container" || platform === "darwin");
  const present = await Promise.all(candidates.map((runtime) => installed(runtime, runner, platform)));
  const available = candidates.filter((_, index) => present[index]);

  // Prefer a runtime that is actually usable. A stale Docker installation
  // must not hide a healthy Podman or Apple container runtime.
  const healthy = await Promise.all(
    available.map(async (candidate) => {
      try {
        await runner(
          candidate,
          candidate === "container"
            ? ["system", "status"]
            : ["info", "--format", "{{.ServerVersion}}"],
          10_000,
        );
        return true;
      } catch {
        return false;
      }
    }),
  );
  const healthyIndex = healthy.indexOf(true);
  const runtime: Runtime | null =
    healthyIndex >= 0 ? available[healthyIndex] : (available[0] ?? null);
  const daemonUp = healthyIndex >= 0;

  const status: ContainerComputerStatus = {
    platform,
    runtime,
    available,
    daemonUp,
    image: false,
    container: "missing",
    network: "unknown",
    image_ref: IMAGE,
    container_name: CONTAINER,
  };
  if (!runtime) return status;

  // Installed is not the same as running. If none of the discovered runtimes
  // answered its health check, preserve the first one so the UI can show the
  // correct start command.
  if (!daemonUp) return status;

  try {
    await runner(runtime, ["image", "inspect", IMAGE]);
    status.image = true;
  } catch {
    /* not pulled yet */
  }

  try {
    const { stdout } = await runner(runtime, ["inspect", CONTAINER]);
    if (runtime === "container") {
      const inspected = JSON.parse(stdout) as Array<{
        configuration?: {
          publishedPorts?: Array<{ hostAddress?: string; containerPort?: number }>;
        };
        status?: { state?: string };
      }>;
      const detail = inspected[0];
      status.container = detail?.status?.state === "running" ? "running" : "stopped";
      status.network = applePortsAreLocal(detail?.configuration?.publishedPorts)
        ? "loopback"
        : "unsafe";
    } else {
      const inspected = JSON.parse(stdout) as Array<{
        HostConfig?: {
          PortBindings?: Record<string, Array<{ HostIp?: string }> | null>;
        };
        State?: { Running?: boolean };
      }>;
      const detail = inspected[0];
      status.container = detail?.State?.Running ? "running" : "stopped";
      status.network = dockerPortsAreLocal(detail?.HostConfig?.PortBindings)
        ? "loopback"
        : "unsafe";
    }
  } catch {
    /* no such container */
  }
  return status;
}

const REQUIRED_DESKTOP_PORTS = [5900, 6080] as const;

function loopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "[::1]";
}

function dockerPortsAreLocal(
  bindings: Record<string, Array<{ HostIp?: string }> | null> | undefined,
): boolean {
  if (!bindings) return false;
  const published = Object.values(bindings).flatMap((entries) => entries ?? []);
  return (
    REQUIRED_DESKTOP_PORTS.every((port) => (bindings[`${port}/tcp`]?.length ?? 0) > 0) &&
    published.length > 0 &&
    published.every((entry) => loopback(entry.HostIp))
  );
}

function applePortsAreLocal(
  bindings: Array<{ hostAddress?: string; containerPort?: number }> | undefined,
): boolean {
  if (!bindings?.length) return false;
  return (
    REQUIRED_DESKTOP_PORTS.every((port) =>
      bindings.some((binding) => binding.containerPort === port),
    ) && bindings.every((binding) => loopback(binding.hostAddress))
  );
}

/** The commands the user is shown, built from the same constants the check
 * above uses — so the instructions can't drift from what we look for. */
export function setupCommands(
  runtime: Runtime | null,
  platform: NodeJS.Platform = process.platform,
) {
  const install =
    platform === "darwin"
      ? "brew install podman; podman machine init; podman machine start"
      : platform === "win32"
        ? "winget install -e --id RedHat.Podman-Desktop"
        : null;
  const runtimeStart =
    runtime === "container"
      ? "container system start"
      : runtime === "podman" && platform !== "linux"
        ? "podman machine init; podman machine start"
        : runtime === "docker" && platform === "darwin"
          ? "colima start || open -a Docker"
          : runtime === "docker" && platform === "linux"
            ? "sudo systemctl start docker"
            : null;

  if (!runtime) {
    return {
      install,
      runtimeStart: null,
      pull: null,
      run: null,
      start: null,
      stop: null,
      remove: null,
      view: "http://localhost:6080/vnc.html",
    };
  }

  return {
    install,
    runtimeStart,
    pull: `${runtime} pull ${IMAGE}`,
    // 6080 is the desktop in a browser, 5900 for a native VNC viewer
    run: `${runtime} run -d --name ${CONTAINER} -p 127.0.0.1:6080:6080 -p 127.0.0.1:5900:5900 ${IMAGE}`,
    start: `${runtime} start ${CONTAINER}`,
    stop: `${runtime} stop ${CONTAINER}`,
    remove:
      runtime === "container"
        ? `${runtime} rm --force ${CONTAINER}`
        : `${runtime} rm -f ${CONTAINER}`,
    view: "http://localhost:6080/vnc.html",
  };
}
