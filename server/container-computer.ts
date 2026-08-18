// Cua-backed Local VM lifecycle and health checks.
//
// OpenMausBot owns only the sandbox boundary: image preparation, container
// lifecycle, resource limits, loopback viewer, and the single-bot lease in the
// harness. Desktop automation itself is Cua Driver. Agents connect directly to
// `cua-driver mcp` inside the container; this module never reimplements clicks,
// typing, screenshots, accessibility, or window discovery.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { augmentedPath } from "./env-path.ts";
import { DATA_DIR } from "./config.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

const run = promisify(execFile);
const SCREENSHOT_STATUS_TTL_MS = 10_000;

export type CommandRunner = (
  command: string,
  args: string[],
  timeout?: number,
) => Promise<{ stdout: string }>;

export const CUA_DRIVER_VERSION = "0.20.0";
export const BASE_IMAGE_REPOSITORY = "docker.io/trycua/xfce-cua";
// Official multi-architecture Cua XFCE 0.1.0 manifest (amd64 + arm64).
export const BASE_IMAGE_DIGEST = "sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b";
export const BASE_IMAGE = `${BASE_IMAGE_REPOSITORY}@${BASE_IMAGE_DIGEST}`;
// This tag is built locally from the pinned Cua base. The explicit localhost
// registry is required by Podman: it prepends localhost to unqualified build
// tags, then may otherwise resolve the same name to Docker Hub when running it.
// Image and container labels below remain the authoritative compatibility
// check, not the mutable tag.
export const IMAGE_REPOSITORY = "localhost/openmausbot/cua-local-vm";
export const IMAGE_LAYER_VERSION = "3";
export const IMAGE_LAYER_LABEL = "com.openmausbot.image-layer";
export const IMAGE = `${IMAGE_REPOSITORY}:driver-${CUA_DRIVER_VERSION}-v${IMAGE_LAYER_VERSION}`;
export const CONTAINER = "openmausbot-computer";
export const MANAGED_LABEL = "com.openmausbot.local-vm";
export const DRIVER_LABEL = "com.openmausbot.cua-driver";
export const BASE_IMAGE_LABEL = "com.openmausbot.cua-base";
export const WORKSPACE_LABEL = "com.openmausbot.workspace";
export const VM_WORKSPACE_DIR = join(DATA_DIR, "vm-home");
export const VM_WORKSPACE_GUEST = "/home/cua/workspace";
export const DISPLAY = ":1";
export const CUA_SOCKET = "/run/user/1000/openmausbot-cua.sock";
export const CUA_EXECUTABLE = "/usr/local/libexec/openmausbot/cua-driver";

const RUNTIMES = ["docker", "podman", "container"] as const;
export type Runtime = (typeof RUNTIMES)[number];
export type LifecycleAction = "pull" | "run" | "start" | "stop" | "remove";

const INTERNAL_VIEWER_PORT = 6901;
const HOST_VIEWER_PORT = 6080;
const MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
const NANO_CPUS = 2_000_000_000;
const PIDS_LIMIT = 512;

const LINUX_WHEELS = {
  x86_64: {
    url: "https://files.pythonhosted.org/packages/fa/d7/a43008a328a40c85e7bc706fc20235b9abedc75e28b413817655153157ff/cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl",
    sha256: "f60c35696a37f37ac954935e478ae4754f220856d022036625c9400d72185961",
  },
  aarch64: {
    url: "https://files.pythonhosted.org/packages/94/9d/1c1838b69067e83266c3d2aae02d74eef353a43dc8644884ccf03fe7f933/cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl",
    sha256: "48833bc5e4c60e701fc9eefb57dbac36ec77ef3990f816fbbe85b4e954af2c77",
  },
} as const;

/** Reproducible, multi-architecture derivative of Cua's sandbox desktop.
 * Both Linux wheels are exact-version and SHA-256 verified. Supervisor owns
 * the daemon so it starts, restarts, and stops with the desktop container. */
export function managedImageDockerfile(): string {
  return `FROM ${BASE_IMAGE}
USER root
RUN set -eux; \\
    arch="$(uname -m)"; \\
    case "$arch" in \\
      x86_64) wheel_url='${LINUX_WHEELS.x86_64.url}'; wheel_sha='${LINUX_WHEELS.x86_64.sha256}'; wheel_path='/tmp/cua_driver-${CUA_DRIVER_VERSION}-py3-none-manylinux_2_31_x86_64.whl' ;; \\
      aarch64|arm64) wheel_url='${LINUX_WHEELS.aarch64.url}'; wheel_sha='${LINUX_WHEELS.aarch64.sha256}'; wheel_path='/tmp/cua_driver-${CUA_DRIVER_VERSION}-py3-none-manylinux_2_31_aarch64.whl' ;; \\
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \\
    esac; \\
    curl -fsSL "$wheel_url" -o "$wheel_path"; \\
    echo "$wheel_sha  $wheel_path" | sha256sum -c -; \\
    /opt/venv/bin/python -m pip install --no-cache-dir --force-reinstall --no-deps "$wheel_path"; \\
    rm -f "$wheel_path"; \\
    driver_bin="$(find /opt/venv/lib -path '*/cua_driver/bin/cua-driver' -type f -print -quit)"; \\
    test -n "$driver_bin"; \\
    install -D -m 0755 "$driver_bin" ${CUA_EXECUTABLE}; \\
    install -d -o cua -g cua -m 0700 ${VM_WORKSPACE_GUEST}; \\
    test "$(${CUA_EXECUTABLE} --version)" = "cua-driver ${CUA_DRIVER_VERSION}"
RUN printf '%s\\n' \\
      '#!/bin/sh' \\
      'set -eu' \\
      'workspace=${VM_WORKSPACE_GUEST}' \\
      'profiles="$workspace/.browser-profiles"' \\
      'mkdir -p "$profiles/google-chrome" "$profiles/chromium" "$HOME/.config"' \\
      'chmod 0700 "$workspace" "$profiles" "$profiles/google-chrome" "$profiles/chromium"' \\
      'migrate_profile() {' \\
      '  name="$1"' \\
      '  source="$HOME/.config/$name"' \\
      '  target="$profiles/$name"' \\
      '  if [ -d "$source" ] && [ ! -L "$source" ] && [ -z "$(find "$target" -mindepth 1 -print -quit)" ]; then' \\
      '    cp -a "$source"/. "$target"/' \\
      '  fi' \\
      '  rm -rf "$source"' \\
      '  ln -s "$target" "$source"' \\
      '}' \\
      'migrate_profile google-chrome' \\
      'migrate_profile chromium' \\
      'find "$profiles" \\( -name SingletonLock -o -name SingletonSocket -o -name SingletonCookie -o -name .parentlock \\) -delete' \\
      > /usr/local/bin/prepare-openmausbot-workspace.sh \\
    && chmod 0755 /usr/local/bin/prepare-openmausbot-workspace.sh
RUN printf '%s\\n' \\
      '#!/bin/sh' \\
      '/usr/local/bin/prepare-openmausbot-workspace.sh' \\
      'attempt=0' \\
      'until DISPLAY=:1 xset q >/dev/null 2>&1; do' \\
      '  attempt=$((attempt + 1))' \\
      '  if [ "$attempt" -ge 45 ]; then echo "X display :1 did not become ready within 45 seconds" >&2; exit 1; fi' \\
      '  sleep 1' \\
      'done' \\
      'exec env CUA_DRIVER_INSTALL_CHANNEL=python_package CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${CUA_EXECUTABLE} serve --socket ${CUA_SOCKET} --permission-mode standard' \\
      > /usr/local/bin/start-openmausbot-cua-driver.sh \\
    && chmod 0755 /usr/local/bin/start-openmausbot-cua-driver.sh
RUN printf '%s\\n' \\
      '' \\
      '[program:openmausbot-cua-driver]' \\
      'command=/usr/local/bin/start-openmausbot-cua-driver.sh' \\
      'user=cua' \\
      'environment=HOME="/home/cua",USER="cua",DISPLAY=":1"' \\
      'autorestart=true' \\
      'startsecs=2' \\
      'stdout_logfile=/var/log/supervisor/cua-driver.log' \\
      'stderr_logfile=/var/log/supervisor/cua-driver.error.log' \\
      'priority=30' \\
      >> /etc/supervisor/supervisord.conf
LABEL ${MANAGED_LABEL}="1" \\
      ${DRIVER_LABEL}="${CUA_DRIVER_VERSION}" \\
      ${BASE_IMAGE_LABEL}="${BASE_IMAGE_DIGEST}" \\
      ${IMAGE_LAYER_LABEL}="${IMAGE_LAYER_VERSION}"
`;
}

async function sh(cmd: string, args: string[], timeout = 8000): Promise<{ stdout: string }> {
  const { stdout } = await run(cmd, args, {
    timeout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
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
  runtime: Runtime | null;
  available: Runtime[];
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  desktop_error: string | null;
  ready: boolean;
  problem: string | null;
  image_ref: string;
  image_id: string | null;
  base_image_ref: string;
  driver_version: string;
  container_name: string;
  workspace_path: string;
  workspace_guest_path: string;
  viewer_url: string;
}

function emptyStatus(platform: NodeJS.Platform): ContainerComputerStatus {
  return {
    platform,
    runtime: null,
    available: [],
    daemonUp: false,
    image: false,
    imageMatches: false,
    managed: false,
    container: "missing",
    network: "unknown",
    security: "unknown",
    persistence: "unknown",
    desktopReady: false,
    desktop_error: null,
    ready: false,
    problem: "Install a supported container runtime first",
    image_ref: IMAGE,
    image_id: null,
    base_image_ref: BASE_IMAGE,
    driver_version: CUA_DRIVER_VERSION,
    container_name: CONTAINER,
    workspace_path: VM_WORKSPACE_DIR,
    workspace_guest_path: VM_WORKSPACE_GUEST,
    viewer_url: `http://127.0.0.1:${HOST_VIEWER_PORT}/vnc.html`,
  };
}

function statusProblem(status: ContainerComputerStatus): string | null {
  if (!status.runtime) return "Install a supported container runtime first";
  if (!status.daemonUp) return `Start ${status.runtime} first`;
  if (!status.image) return `Prepare the Cua desktop image with Driver ${CUA_DRIVER_VERSION}`;
  if (status.container === "missing") return "Create the Local VM";
  if (!status.imageMatches) return "The existing Local VM uses an older desktop or Cua Driver; recreate it";
  if (!status.managed) return "The existing container was not created by OpenMausBot; recreate it";
  if (status.network === "unsafe") return "The existing Local VM exposes its viewer publicly; recreate it";
  if (status.security === "unsafe") return "The existing Local VM is missing safety limits; recreate it";
  if (status.persistence === "unsafe") return "The existing Local VM is missing its durable workspace; recreate it";
  if (status.container === "stopped") return "This desktop image cannot safely resume; recreate the Local VM";
  if (status.desktop_error) return `The Local VM desktop failed to start: ${status.desktop_error}`;
  if (!status.desktopReady) return "The Local VM started, but Cua Driver is not ready yet";
  return null;
}

function imageLabelsMatch(labels: Record<string, string> | undefined): boolean {
  return (
    labels?.[MANAGED_LABEL] === "1" &&
    labels?.[DRIVER_LABEL] === CUA_DRIVER_VERSION &&
    labels?.[BASE_IMAGE_LABEL] === BASE_IMAGE_DIGEST &&
    labels?.[IMAGE_LAYER_LABEL] === IMAGE_LAYER_VERSION
  );
}

function containerLabelsMatch(labels: Record<string, string> | undefined): boolean {
  return imageLabelsMatch(labels) && labels?.[WORKSPACE_LABEL] === "1";
}

function normalizeImageId(id: string | undefined): string | null {
  return id?.trim().replace(/^sha256:/, "") || null;
}

function inspectedImage(stdout: string): {
  labels: Record<string, string> | undefined;
  id: string | null;
} {
  const parsed = JSON.parse(stdout) as Array<{
    Id?: string;
    id?: string;
    Config?: { Labels?: Record<string, string> };
    config?: { Labels?: Record<string, string>; labels?: Record<string, string> };
    configuration?: { labels?: Record<string, string>; descriptor?: { digest?: string } };
  }>;
  const image = parsed[0];
  return {
    labels:
      image?.Config?.Labels ?? image?.config?.Labels ?? image?.config?.labels ?? image?.configuration?.labels,
    id: normalizeImageId(image?.Id ?? image?.id ?? image?.configuration?.descriptor?.digest),
  };
}

function viewerPassword(env: string[] | Record<string, string> | undefined): string | null {
  if (Array.isArray(env)) {
    return env.find((entry) => entry.startsWith("VNC_PW="))?.slice("VNC_PW=".length) || null;
  }
  return env?.VNC_PW || null;
}

function viewerUrl(password: string | null): string {
  const base = `http://127.0.0.1:${HOST_VIEWER_PORT}/vnc.html`;
  if (!password) return base;
  const fragment = new URLSearchParams({ autoconnect: "true", resize: "scale", password });
  return `${base}#${fragment.toString()}`;
}

function cuaExecArgs(args: string[], interactive = false): string[] {
  return [
    "exec",
    ...(interactive ? ["-i"] : []),
    "-u",
    "cua",
    "-e",
    "HOME=/home/cua",
    "-e",
    `DISPLAY=${DISPLAY}`,
    "-e",
    "CUA_DRIVER_INSTALL_CHANNEL=python_package",
    "-e",
    "CUA_DRIVER_RS_TELEMETRY_ENABLED=0",
    CONTAINER,
    CUA_EXECUTABLE,
    ...args,
  ];
}

export async function containerComputerStatus(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
): Promise<ContainerComputerStatus> {
  const status = emptyStatus(platform);
  // Apple's `container` CLI is macOS-only. Ignoring an unrelated executable
  // with that generic name off macOS avoids false detection.
  const candidates = RUNTIMES.filter((runtime) => runtime !== "container" || platform === "darwin");
  const present = await Promise.all(candidates.map((runtime) => installed(runtime, runner, platform)));
  status.available = candidates.filter((_, index) => present[index]);

  const healthy = await Promise.all(
    status.available.map(async (candidate) => {
      try {
        await runner(
          candidate,
          candidate === "container" ? ["system", "status"] : ["info", "--format", "{{.ServerVersion}}"],
          10_000,
        );
        return true;
      } catch {
        return false;
      }
    }),
  );
  const healthyIndex = healthy.indexOf(true);
  status.runtime = healthyIndex >= 0 ? status.available[healthyIndex] : (status.available[0] ?? null);
  status.daemonUp = healthyIndex >= 0;
  if (!status.runtime || !status.daemonUp) {
    status.problem = statusProblem(status);
    return status;
  }

  try {
    const { stdout } = await runner(status.runtime, ["image", "inspect", IMAGE]);
    const image = inspectedImage(stdout);
    status.image = imageLabelsMatch(image.labels);
    status.image_id = image.id;
  } catch {
    // The prepared OpenMausBot derivative has not been built yet.
  }

  try {
    const { stdout } = await runner(status.runtime, ["inspect", CONTAINER]);
    if (status.runtime === "container") {
      const inspected = JSON.parse(stdout) as Array<{
        configuration?: {
          image?: string | { reference?: string; descriptor?: { digest?: string } };
          imageReference?: string;
          resources?: { cpus?: number; memoryInBytes?: number };
          publishedPorts?: Array<{ hostAddress?: string; containerPort?: number }>;
          environment?: string[] | Record<string, string>;
          labels?: Record<string, string>;
          mounts?: Array<{ source?: string; destination?: string; options?: string[] }>;
        };
        status?: { state?: string };
      }>;
      const detail = inspected[0];
      status.container = detail?.status?.state === "running" ? "running" : "stopped";
      status.network = applePortsAreLocal(detail?.configuration?.publishedPorts) ? "loopback" : "unsafe";
      const appleImage =
        typeof detail?.configuration?.image === "string"
          ? detail.configuration.image
          : detail?.configuration?.image?.reference ?? detail?.configuration?.imageReference;
      const appleImageId =
        typeof detail?.configuration?.image === "object"
          ? normalizeImageId(detail.configuration.image.descriptor?.digest)
          : null;
      status.imageMatches =
        appleImage === IMAGE && status.image_id !== null && appleImageId === status.image_id;
      status.managed = containerLabelsMatch(detail?.configuration?.labels);
      status.persistence = appleWorkspaceMountIsSafe(detail?.configuration?.mounts, platform)
        ? "durable"
        : "unsafe";
      const resources = detail?.configuration?.resources;
      status.security =
        (resources?.memoryInBytes ?? 0) >= MEMORY_BYTES && resources?.cpus === 2 ? "hardened" : "unsafe";
      status.viewer_url = viewerUrl(viewerPassword(detail?.configuration?.environment));
    } else {
      const inspected = JSON.parse(stdout) as Array<{
        Config?: { Image?: string; Labels?: Record<string, string>; Env?: string[] };
        HostConfig?: {
          PortBindings?: Record<string, Array<{ HostIp?: string }> | null>;
          Memory?: number;
          MemorySwap?: number;
          NanoCpus?: number;
          PidsLimit?: number | null;
          CapDrop?: string[] | null;
          CapAdd?: string[] | null;
        };
        Mounts?: Array<{
          Type?: string;
          Source?: string;
          Destination?: string;
          RW?: boolean;
        }>;
        State?: { Running?: boolean };
        Image?: string;
      }>;
      const detail = inspected[0];
      status.container = detail?.State?.Running ? "running" : "stopped";
      status.network = dockerPortsAreLocal(detail?.HostConfig?.PortBindings) ? "loopback" : "unsafe";
      status.imageMatches =
        detail?.Config?.Image === IMAGE &&
        imageLabelsMatch(detail?.Config?.Labels) &&
        status.image_id !== null &&
        normalizeImageId(detail?.Image) === status.image_id;
      status.managed = containerLabelsMatch(detail?.Config?.Labels);
      status.persistence = dockerWorkspaceMountIsSafe(detail?.Mounts, platform) ? "durable" : "unsafe";
      status.security = dockerSecurityIsHardened(detail?.HostConfig) ? "hardened" : "unsafe";
      status.viewer_url = viewerUrl(viewerPassword(detail?.Config?.Env));
    }
  } catch {
    // No container with this name.
  }

  const canProbe =
    status.container === "running" &&
    status.imageMatches &&
    status.managed &&
    status.network === "loopback" &&
    status.security === "hardened" &&
    status.persistence === "durable";
  if (canProbe) {
    try {
      const expected = `cua-driver ${CUA_DRIVER_VERSION}`;
      const version = await runner(status.runtime, cuaExecArgs(["--version"]), 8000);
      if (version.stdout.trim() !== expected) throw new Error(`expected ${expected}`);
      await runner(status.runtime, cuaExecArgs(["status", "--socket", CUA_SOCKET]), 8000);
      const health = await runner(
        status.runtime,
        cuaExecArgs(["call", "health_report", "{}", "--socket", CUA_SOCKET]),
        15_000,
      );
      const report = JSON.parse(health.stdout) as { schema_version?: string; overall?: string; checks?: unknown[] };
      if (
        report.schema_version !== "1" ||
        !Array.isArray(report.checks) ||
        (report.overall !== "ok" && report.overall !== "degraded")
      ) {
        throw new Error(`Cua health report is ${report.overall ?? "invalid"}`);
      }
      const readinessShot = "/tmp/openmausbot-readiness.png";
      await runner(
        status.runtime,
        cuaExecArgs([
          "call",
          "get_desktop_state",
          "{}",
          "--socket",
          CUA_SOCKET,
          "--screenshot-out-file",
          readinessShot,
        ]),
        20_000,
      );
      const captured = await runner(
        status.runtime,
        ["exec", CONTAINER, "base64", "-w0", readinessShot],
        20_000,
      );
      if (!wholeScreenshot(Buffer.from(captured.stdout.trim(), "base64")).ok) {
        throw new Error("Cua Driver returned an incomplete readiness screenshot");
      }
      status.desktopReady = true;
    } catch (error) {
      // An empty log means XFCE and the supervisor-owned Cua daemon are
      // probably still starting. A real startup failure should be actionable
      // in the panel instead of looking like an endless readiness wait.
      status.desktop_error = error instanceof Error ? error.message.slice(0, 320) : null;
      try {
        const errorLog = await runner(
          status.runtime,
          ["exec", CONTAINER, "tail", "-n", "4", "/var/log/supervisor/cua-driver.error.log"],
          4000,
        );
        status.desktop_error =
          errorLog.stdout.replace(/\s+/g, " ").trim().slice(0, 320) ||
          status.desktop_error;
      } catch {
        // The log may not exist during the first seconds of container boot.
      }
    }
  }

  status.problem = statusProblem(status);
  status.ready = status.problem === null;
  return status;
}

function loopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "[::1]";
}

function dockerPortsAreLocal(
  bindings: Record<string, Array<{ HostIp?: string }> | null> | undefined,
): boolean {
  const viewer = bindings?.[`${INTERNAL_VIEWER_PORT}/tcp`] ?? [];
  const published = Object.values(bindings ?? {}).flatMap((entries) => entries ?? []);
  return viewer.length > 0 && published.length === viewer.length && published.every((entry) => loopback(entry.HostIp));
}

function applePortsAreLocal(
  bindings: Array<{ hostAddress?: string; containerPort?: number }> | undefined,
): boolean {
  return Boolean(
    bindings?.length === 1 &&
      bindings[0]?.containerPort === INTERNAL_VIEWER_PORT &&
      loopback(bindings[0]?.hostAddress),
  );
}

function sameWorkspaceSource(source: string | undefined, platform: NodeJS.Platform): boolean {
  if (!source) return false;
  const actual = resolve(source);
  const expected = resolve(VM_WORKSPACE_DIR);
  return platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}

function dockerWorkspaceMountIsSafe(
  mounts:
    | Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>
    | undefined,
  platform: NodeJS.Platform,
): boolean {
  return Boolean(
    mounts?.length === 1 &&
      mounts[0]?.Type === "bind" &&
      sameWorkspaceSource(mounts[0]?.Source, platform) &&
      mounts[0]?.Destination === VM_WORKSPACE_GUEST &&
      mounts[0]?.RW !== false,
  );
}

function appleWorkspaceMountIsSafe(
  mounts: Array<{ source?: string; destination?: string; options?: string[] }> | undefined,
  platform: NodeJS.Platform,
): boolean {
  const options = mounts?.[0]?.options ?? [];
  return Boolean(
    mounts?.length === 1 &&
      sameWorkspaceSource(mounts[0]?.source, platform) &&
      mounts[0]?.destination === VM_WORKSPACE_GUEST &&
      !options.some((option) => option === "ro" || option === "readonly"),
  );
}

function dockerSecurityIsHardened(
  config:
    | {
        Memory?: number;
        MemorySwap?: number;
        NanoCpus?: number;
        PidsLimit?: number | null;
        CapDrop?: string[] | null;
        CapAdd?: string[] | null;
      }
    | undefined,
): boolean {
  if (!config) return false;
  const capDrop = (config.CapDrop ?? []).map((cap) => cap.toLowerCase());
  const capAdd = (config.CapAdd ?? [])
    .map((cap) => cap.toLowerCase().replace(/^cap_/, ""))
    .sort();
  return (
    (config.Memory ?? 0) >= MEMORY_BYTES &&
    (config.MemorySwap ?? 0) === MEMORY_BYTES &&
    (config.NanoCpus ?? 0) === NANO_CPUS &&
    (config.PidsLimit ?? 0) > 0 &&
    (config.PidsLimit ?? Infinity) <= PIDS_LIMIT &&
    capDrop.includes("all") &&
    capAdd.join(",") === "setgid,setuid"
  );
}

export function containerRunArgs(runtime: Runtime, password = "CHANGE_ME"): string[] {
  const common = ["run", "-d", "--name", CONTAINER];
  common.push(
    "--label",
    `${MANAGED_LABEL}=1`,
    "--label",
    `${DRIVER_LABEL}=${CUA_DRIVER_VERSION}`,
    "--label",
    `${BASE_IMAGE_LABEL}=${BASE_IMAGE_DIGEST}`,
    "--label",
    `${IMAGE_LAYER_LABEL}=${IMAGE_LAYER_VERSION}`,
    "--label",
    `${WORKSPACE_LABEL}=1`,
  );
  if (runtime === "container") {
    // Apple container already places each Linux container in a lightweight VM.
    common.push(
      "--memory",
      "4g",
      "--cpus",
      "2",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "SETUID",
      "--cap-add",
      "SETGID",
      "--shm-size",
      "512m",
    );
  } else {
    common.push(
      "--hostname",
      CONTAINER,
      "--memory",
      "4g",
      "--memory-swap",
      "4g",
      "--cpus",
      "2",
      "--pids-limit",
      String(PIDS_LIMIT),
      "--cap-drop",
      "ALL",
      "--cap-add",
      "SETUID",
      "--cap-add",
      "SETGID",
      "--shm-size",
      "512m",
    );
  }
  common.push(
    "--mount",
    runtime === "podman"
      ? `type=bind,source=${VM_WORKSPACE_DIR},target=${VM_WORKSPACE_GUEST},relabel=private,U=true`
      : `type=bind,source=${VM_WORKSPACE_DIR},target=${VM_WORKSPACE_GUEST}`,
    "-e",
    `VNC_PW=${password}`,
    "-p",
    `127.0.0.1:${HOST_VIEWER_PORT}:${INTERNAL_VIEWER_PORT}`,
    IMAGE,
  );
  return common;
}

async function ensureVmWorkspace(platform: NodeJS.Platform): Promise<void> {
  await mkdir(VM_WORKSPACE_DIR, { recursive: true, mode: 0o700 });
  if (platform !== "win32") await chmod(VM_WORKSPACE_DIR, 0o700);
}

async function prepareManagedImage(runtime: Runtime, runner: CommandRunner): Promise<void> {
  await runner(runtime, ["pull", BASE_IMAGE], 10 * 60_000);
  const context = await mkdtemp(join(tmpdir(), "openmausbot-cua-image-"));
  try {
    await writeFile(join(context, "Dockerfile"), managedImageDockerfile(), { mode: 0o600 });
    await runner(runtime, ["build", "-t", IMAGE, context], 10 * 60_000);
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

export async function containerComputerAction(
  action: LifecycleAction,
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
): Promise<ContainerComputerStatus> {
  if (runner === sh && platform === process.platform) screenshotStatusCache = null;
  const before = await containerComputerStatus(runner, platform);
  const runtime = before.runtime;
  if (!runtime) throw Object.assign(new Error(before.problem ?? "No container runtime is installed"), { status: 409 });
  if (!before.daemonUp) throw Object.assign(new Error(before.problem ?? `${runtime} is not running`), { status: 409 });

  if (action === "run" && before.container !== "missing") {
    throw Object.assign(new Error("A Local VM already exists; remove it before creating a replacement"), { status: 409 });
  }
  if (action === "run" && !before.image) {
    throw Object.assign(new Error("Prepare the Cua desktop image before creating the Local VM"), { status: 409 });
  }
  if (action === "start") {
    throw Object.assign(new Error("This desktop image cannot safely resume; remove and recreate the Local VM"), {
      status: 409,
    });
  }
  if (action === "stop" && before.container !== "running") {
    throw Object.assign(new Error("The Local VM is not running"), { status: 409 });
  }
  if (action === "remove" && before.container === "missing") return before;

  if (action === "pull") {
    await prepareManagedImage(runtime, runner);
  } else {
    if (action === "run") await ensureVmWorkspace(platform);
    const args =
      action === "run"
        ? containerRunArgs(runtime, randomBytes(6).toString("base64url"))
        : action === "remove"
          ? ["rm", runtime === "container" ? "--force" : "-f", CONTAINER]
          : [action, CONTAINER];
    await runner(runtime, args, 2 * 60_000);
  }
  return containerComputerStatus(runner, platform);
}

type ScreenshotCheck = { ok: boolean; mime: "image/png" | "image/jpeg" };

function wholeScreenshot(bytes: Buffer): ScreenshotCheck {
  if (bytes.length < 512) return { ok: false, mime: "image/png" };
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (png) {
    return {
      ok: bytes.subarray(Math.max(0, bytes.length - 12)).includes(Buffer.from("IEND", "ascii")),
      mime: "image/png",
    };
  }
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  return {
    ok: jpeg && bytes.subarray(Math.max(0, bytes.length - 32)).includes(Buffer.from([0xff, 0xd9])),
    mime: "image/jpeg",
  };
}

export async function containerComputerScreenshot(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const cacheable = runner === sh && platform === process.platform;
  const now = Date.now();
  const status =
    cacheable && screenshotStatusCache && screenshotStatusCache.expiresAt > now
      ? screenshotStatusCache.status
      : await containerComputerStatus(runner, platform);
  if (!status.ready || !status.runtime) {
    if (cacheable) screenshotStatusCache = null;
    throw Object.assign(new Error(status.problem ?? "The Local VM is not ready"), { status: 409 });
  }
  if (cacheable) screenshotStatusCache = { status, expiresAt: now + SCREENSHOT_STATUS_TTL_MS };
  try {
    const screenshot = "/tmp/openmausbot-preview.png";
    await runner(
      status.runtime,
      cuaExecArgs([
        "call",
        "get_desktop_state",
        "{}",
        "--socket",
        CUA_SOCKET,
        "--screenshot-out-file",
        screenshot,
      ]),
      30_000,
    );
    const { stdout } = await runner(status.runtime, ["exec", CONTAINER, "base64", "-w0", screenshot], 30_000);
    const data = stdout.trim();
    const checked = wholeScreenshot(Buffer.from(data, "base64"));
    if (!checked.ok) {
      throw Object.assign(new Error("Cua Driver returned an incomplete screenshot"), { status: 502 });
    }
    return `data:${checked.mime};base64,${data}`;
  } catch (error) {
    if (cacheable) screenshotStatusCache = null;
    throw error;
  }
}

let screenshotStatusCache: { status: ContainerComputerStatus; expiresAt: number } | null = null;

const containerMcpPath = SPAWNED_PROXIES.containerMcp;

/** Spawn contract handed directly to agent runtimes. The tiny host wrapper
 * only preserves stdio through the container CLI; Cua Driver owns the MCP
 * protocol and every computer tool. */
type ContainerMcpLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export function containerComputerMcp(runtime: Runtime): ContainerMcpLaunch {
  return {
    command: process.execPath,
    args: [containerMcpPath, runtime, CONTAINER, CUA_SOCKET],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

/** Commands shown as a transparent fallback. Normal setup builds the pinned
 * derivative through the API, so users do not need to author a Dockerfile. */
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
      view: `http://127.0.0.1:${HOST_VIEWER_PORT}/vnc.html`,
    };
  }
  const command = (args: string[]) => [runtime, ...args].join(" ");
  return {
    install,
    runtimeStart,
    // This is the inspectable base download. The normal Prepare button also
    // builds the checksum-pinned 0.20.0 derivative automatically.
    pull: command(["pull", BASE_IMAGE]),
    run: command(containerRunArgs(runtime)),
    start: null,
    stop: command(["stop", CONTAINER]),
    remove: command(["rm", runtime === "container" ? "--force" : "-f", CONTAINER]),
    view: `http://127.0.0.1:${HOST_VIEWER_PORT}/vnc.html`,
  };
}

/** Cloud boxes still use OpenMausBot's high-latency REST adapter. Local VMs
 * bypass it and mount Cua Driver's official MCP server through
 * containerComputerMcp(). */
export function computerProxyEnv(
  computer: { boxId?: string; token?: string },
): NodeJS.ProcessEnv {
  return { OGB_BOX_ID: computer.boxId ?? "", OGB_BOX_TOKEN: computer.token ?? "" };
}
