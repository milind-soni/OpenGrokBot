// User-managed Existing VM transport and readiness.
//
// This is deliberately not a LocalVmTarget. LocalVmTarget represents a
// container OpenMausBot owns; an Existing VM has no OpenMausBot lifecycle,
// filesystem, image, or isolation contract. The only persisted connection
// detail is a validated SSH config alias.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { CUA_DRIVER_VERSION, wholeScreenshot } from "./container-computer.ts";
import { isValidSshAlias, localVmSshAlias, type AppConfig } from "./config.ts";
import { augmentedPath } from "./env-path.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

export const EXISTING_VM_LEASE_KEY = "existing-vm";
export const EXISTING_VM_REQUIRED_TOOLS = [
  "get_desktop_state",
  "list_apps",
  "click",
  "type_text",
  "press_key",
  "scroll",
] as const;

const SSH_COMMAND = "ssh";
const SSH_OPTIONS = [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=5",
  "-o",
  "ServerAliveCountMax=2",
] as const;
const PROBE_TIMEOUT_MS = 10_000;
const MCP_REQUEST_TIMEOUT_MS = 15_000;
const SCREENSHOT_TIMEOUT_MS = 20_000;
const STATUS_CACHE_TTL_MS = 10_000;
const MAX_PROBE_OUTPUT = 64 * 1024;
const MAX_MCP_LINE_CHARS = 16 * 1024 * 1024;
const MCP_CLOSE_GRACE_MS = 1_500;

export type ExistingVmErrorCode =
  | "ssh-unreachable"
  | "remote-os"
  | "cua-missing"
  | "cua-version"
  | "mcp"
  | "desktop"
  | "timeout";

export class ExistingVmError extends Error {
  readonly code: ExistingVmErrorCode;

  constructor(code: ExistingVmErrorCode, message: string) {
    super(message);
    this.name = "ExistingVmError";
    this.code = code;
  }
}

export type ExistingVmStatus = {
  source: "existing";
  configured: boolean;
  sshAlias: string | null;
  ssh: "not-configured" | "connected" | "unreachable";
  os: "unknown" | "linux" | "unsupported";
  driver: "unknown" | "compatible" | "missing" | "incompatible";
  mcp: "unknown" | "ready" | "failed";
  tools: string[];
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  errorCode: ExistingVmErrorCode | "not-configured" | null;
  driver_version: string;
  viewer_url: "";
  watch_only: true;
};

export type ExistingVmOptions = {
  /** Test-only executable override; user config never supplies this. */
  sshCommand?: string;
  /** Test-only argv prefix for running a fake SSH executable. */
  sshCommandPrefix?: string[];
  /** Bypass the short status cache for an explicit user re-check. */
  force?: boolean;
};

type CommandResult = { stdout: string; stderr: string };

type CommandFailure = Error & {
  code?: string;
  stderr?: string;
};

function commandFailure(message: string, code?: string, stderr?: string): CommandFailure {
  const error = new Error(message) as CommandFailure;
  if (code) error.code = code;
  if (stderr) error.stderr = stderr;
  return error;
}

/** The only SSH argv used by the Existing VM path. No user-provided options
 * or remote command fragments can reach this function. */
function sshArgs(alias: string, remote: readonly string[]): string[] {
  if (!isValidSshAlias(alias)) throw new Error("invalid Existing VM SSH config alias");
  return [...SSH_OPTIONS, alias, ...remote];
}

function spawnedSshArgs(alias: string, remote: readonly string[], options: ExistingVmOptions): string[] {
  return [...(options.sshCommandPrefix ?? []), ...sshArgs(alias, remote)];
}

export function existingVmMcpArgs(alias: string): string[] {
  return sshArgs(alias, ["cua-driver", "mcp"]);
}

export function existingVmLivenessArgs(alias: string): string[] {
  return sshArgs(alias, ["true"]);
}

function collectBounded(target: { value: string; size: number }, chunk: string): void {
  target.size += Buffer.byteLength(chunk, "utf8");
  if (target.size > MAX_PROBE_OUTPUT) throw new Error("SSH probe output exceeded its limit");
  target.value += chunk;
}

function runSshCommand(
  alias: string,
  remote: readonly string[],
  options: ExistingVmOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const { sshCommand = SSH_COMMAND } = options;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(sshCommand, spawnedSshArgs(alias, remote, options), {
        shell: false,
        windowsHide: true,
        env: { ...process.env, PATH: augmentedPath() },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdout = { value: "", size: 0 };
    const stderr = { value: "", size: 0 };
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      killTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {}
        settleReject(new ExistingVmError("timeout", "SSH command timed out"));
      }, MCP_CLOSE_GRACE_MS);
      killTimer.unref?.();
    }, PROBE_TIMEOUT_MS);
    timeout.unref?.();

    const clearTimers = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
    };
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimers();
      finish();
    };
    const settleReject = (error: Error) => settle(() => reject(error));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled || outputExceeded) return;
      try {
        collectBounded(stdout, chunk);
      } catch {
        outputExceeded = true;
        settleReject(new ExistingVmError("mcp", "SSH probe output exceeded its limit"));
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (settled || outputExceeded) return;
      try {
        collectBounded(stderr, chunk);
      } catch {
        outputExceeded = true;
        settleReject(new ExistingVmError("mcp", "SSH probe output exceeded its limit"));
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      settleReject(commandFailure(`SSH could not start: ${error.message}`, (error as NodeJS.ErrnoException).code));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (timedOut) {
        settleReject(new ExistingVmError("timeout", "SSH command timed out"));
        return;
      }
      if (code !== 0) {
        const detail = stderr.value.trim().slice(-800);
        settleReject(commandFailure(detail || `SSH exited ${code ?? signal ?? "without a status"}`, "SSH_EXIT", stderr.value));
        return;
      }
      settle(() => resolve({ stdout: stdout.value, stderr: stderr.value }));
    });
    try {
      child.stdin.end();
    } catch (error) {
      settleReject(commandFailure(`SSH stdin failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
}

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: unknown };
};

class ExistingVmMcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly exited: Promise<void>;
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private stderr = "";
  private closePromise: Promise<void> | null = null;

  constructor(alias: string, options: ExistingVmOptions = {}) {
    const { sshCommand = SSH_COMMAND } = options;
    this.child = spawn(sshCommand, spawnedSshArgs(alias, ["cua-driver", "mcp"], options), {
      shell: false,
      windowsHide: true,
      env: { ...process.env, PATH: augmentedPath() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => this.child.once("close", () => resolve()));
    this.child.stdin.on("error", () => {});
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_096);
    });
    this.child.on("error", (error) => this.fail(new ExistingVmError("mcp", `SSH MCP transport could not start: ${error.message}`)));
    this.child.on("close", (code, signal) => {
      this.closed = true;
      const detail = this.stderr.trim();
      this.fail(
        new ExistingVmError(
          "mcp",
          detail || `SSH MCP transport exited ${code ?? signal ?? "without a status"}`,
        ),
      );
    });
  }

  private read(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    if (this.buffer.length > MAX_MCP_LINE_CHARS) {
      this.fail(new ExistingVmError("mcp", "CUA MCP response exceeded its output limit"));
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        this.fail(new ExistingVmError("mcp", "CUA MCP returned invalid JSON"));
        return;
      }
      if (typeof message.id !== "number") continue;
      const waiting = this.pending.get(message.id);
      if (!waiting) continue;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) {
        waiting.reject(new ExistingVmError("mcp", String(message.error.message ?? "CUA MCP request failed")));
      } else {
        waiting.resolve(message.result);
      }
    }
  }

  private fail(error: Error): void {
    for (const [id, waiting] of this.pending) {
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = MCP_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) return Promise.reject(new ExistingVmError("mcp", "CUA MCP transport is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ExistingVmError("timeout", `CUA MCP ${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ExistingVmError("mcp", `CUA MCP request failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      // The request that follows reports the closed transport to the caller.
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (!this.closed) {
        try {
          this.child.stdin.end();
        } catch {}
        await Promise.race([this.exited, delay(MCP_CLOSE_GRACE_MS)]);
      }
      if (this.child.exitCode === null && this.child.signalCode === null) {
        try {
          this.child.kill("SIGTERM");
        } catch {}
        await Promise.race([this.exited, delay(500)]);
      }
      if (this.child.exitCode === null && this.child.signalCode === null) {
        try {
          this.child.kill("SIGKILL");
        } catch {}
      }
      this.closed = true;
      this.fail(new ExistingVmError("mcp", "CUA MCP transport closed"));
    })();
    return this.closePromise;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function desktopImage(result: unknown): { png: string; format: "png" | "jpeg" } {
  const content = result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)
    ? (result as { content: unknown[] }).content
    : [];
  if (result && typeof result === "object" && (result as { isError?: unknown }).isError === true) {
    const first = content[0];
    const message = first && typeof first === "object" && typeof (first as { text?: unknown }).text === "string"
      ? (first as { text: string }).text
      : "get_desktop_state reported an error";
    throw new ExistingVmError("desktop", message);
  }
  const image = content.find(
    (item): item is { type: "image"; data: string; mimeType?: string } =>
      Boolean(item) &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "image" &&
      typeof (item as { data?: unknown }).data === "string",
  );
  if (!image) throw new ExistingVmError("desktop", "get_desktop_state returned no desktop image");
  const bytes = Buffer.from(image.data, "base64");
  const checked = wholeScreenshot(bytes);
  if (!checked.ok) throw new ExistingVmError("desktop", "get_desktop_state returned an incomplete desktop image");
  return { png: image.data, format: checked.mime === "image/jpeg" ? "jpeg" : "png" };
}

async function runMcpProbe(
  alias: string,
  options: ExistingVmOptions,
): Promise<{ tools: string[]; screenshot: { png: string; format: "png" | "jpeg" } }> {
  const client = new ExistingVmMcpClient(alias, options);
  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "openmausbot-existing-vm", version: "1" },
    });
    if (!initialized || typeof initialized !== "object" || typeof (initialized as { protocolVersion?: unknown }).protocolVersion !== "string") {
      throw new ExistingVmError("mcp", "CUA MCP initialize returned an invalid response");
    }
    client.notify("notifications/initialized");
    const listed = await client.request("tools/list", {});
    const tools = listed && typeof listed === "object" && Array.isArray((listed as { tools?: unknown }).tools)
      ? (listed as { tools: unknown[] }).tools
        .map((tool) => tool && typeof tool === "object" ? (tool as { name?: unknown }).name : undefined)
        .filter((name): name is string => typeof name === "string")
      : [];
    const missing = EXISTING_VM_REQUIRED_TOOLS.filter((name) => !tools.includes(name));
    if (missing.length) throw new ExistingVmError("mcp", `CUA MCP is missing required tools: ${missing.join(", ")}`);
    const result = await client.request(
      "tools/call",
      { name: "get_desktop_state", arguments: {} },
      SCREENSHOT_TIMEOUT_MS,
    );
    return { tools, screenshot: desktopImage(result) };
  } finally {
    await client.close();
  }
}

function emptyStatus(alias: string | null): ExistingVmStatus {
  return {
    source: "existing",
    configured: Boolean(alias),
    sshAlias: alias,
    ssh: alias ? "unreachable" : "not-configured",
    os: "unknown",
    driver: "unknown",
    mcp: "unknown",
    tools: [],
    desktopReady: false,
    ready: false,
    problem: alias
      ? "SSH could not reach the Existing VM"
      : "Configure an SSH config alias for the Existing VM in App Settings → Local VM",
    errorCode: alias ? "ssh-unreachable" : "not-configured",
    driver_version: CUA_DRIVER_VERSION,
    viewer_url: "",
    watch_only: true,
  };
}

function safeDetail(error: unknown, alias: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replaceAll(alias, "the configured SSH host")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

async function computeStatus(cfg: AppConfig, options: ExistingVmOptions): Promise<ExistingVmStatus> {
  const alias = localVmSshAlias(cfg);
  const status = emptyStatus(alias);
  if (!alias) return status;

  try {
    const os = await runSshCommand(alias, ["uname", "-s"], options);
    status.ssh = "connected";
    if (os.stdout.trim() !== "Linux") {
      status.os = "unsupported";
      status.errorCode = "remote-os";
      status.problem = `Existing VM requires a Linux guest; SSH reported ${os.stdout.trim().slice(0, 80) || "an unknown OS"}`;
      return status;
    }
    status.os = "linux";
  } catch (error) {
    status.ssh = "unreachable";
    status.errorCode = error instanceof ExistingVmError && error.code === "timeout" ? "timeout" : "ssh-unreachable";
    status.problem = status.errorCode === "timeout"
      ? "SSH timed out while reaching the Existing VM"
      : "SSH could not reach the Existing VM; check the alias, host key, and SSH agent";
    return status;
  }

  let version: CommandResult;
  try {
    version = await runSshCommand(alias, ["cua-driver", "--version"], options);
  } catch (error) {
    status.driver = "missing";
    status.errorCode = "cua-missing";
    status.problem = `CUA Driver is missing or unavailable on the Existing VM${safeDetail(error, alias) ? `: ${safeDetail(error, alias)}` : ""}`;
    return status;
  }
  const match = /^cua-driver\s+([^\s]+)$/m.exec(version.stdout.trim());
  if (!match || match[1] !== CUA_DRIVER_VERSION) {
    status.driver = "incompatible";
    status.errorCode = "cua-version";
    status.problem = `Existing VM needs CUA Driver ${CUA_DRIVER_VERSION}; found ${match?.[1] ?? "an unknown version"}`;
    return status;
  }
  status.driver = "compatible";

  try {
    const probe = await runMcpProbe(alias, options);
    status.mcp = "ready";
    status.tools = probe.tools;
    status.desktopReady = true;
    status.ready = true;
    status.problem = null;
    status.errorCode = null;
  } catch (error) {
    const code = error instanceof ExistingVmError ? error.code : "mcp";
    status.mcp = "failed";
    status.errorCode = code;
    status.problem = code === "desktop"
      ? `SSH reached CUA Driver, but it could not reach the graphical desktop${safeDetail(error, alias) ? `: ${safeDetail(error, alias)}` : ""}`
      : `SSH-launched CUA MCP transport failed${safeDetail(error, alias) ? `: ${safeDetail(error, alias)}` : ""}`;
  }
  return status;
}

const statusCache = new Map<string, { status: ExistingVmStatus; expiresAt: number }>();
const statusInFlight = new Map<string, Promise<ExistingVmStatus>>();

export async function existingVmStatus(
  cfg: AppConfig,
  options: ExistingVmOptions = {},
): Promise<ExistingVmStatus> {
  const alias = localVmSshAlias(cfg);
  if (!alias) return emptyStatus(null);
  const cacheable = !options.sshCommand;
  if (options.force) statusCache.delete(alias);
  if (cacheable) {
    if (!options.force) {
      const cached = statusCache.get(alias);
      if (cached && cached.expiresAt > Date.now()) return cached.status;
      const inFlight = statusInFlight.get(alias);
      if (inFlight) return inFlight;
    }
  }
  const promise = computeStatus(cfg, options);
  if (!cacheable) return promise;
  statusInFlight.set(alias, promise);
  try {
    const status = await promise;
    statusCache.set(alias, { status, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
    return status;
  } finally {
    if (statusInFlight.get(alias) === promise) statusInFlight.delete(alias);
  }
}

export async function existingVmScreenshot(
  cfg: AppConfig,
  options: ExistingVmOptions = {},
): Promise<{ png: string; format: "png" | "jpeg" }> {
  const status = await existingVmStatus(cfg, options);
  const alias = status.sshAlias;
  if (!alias || !status.ready) {
    throw Object.assign(new Error(status.problem ?? "The Existing VM is not ready"), { status: 409 });
  }
  try {
    return (await runMcpProbe(alias, options)).screenshot;
  } catch (error) {
    if (!options.sshCommand) statusCache.delete(alias);
    const detail = safeDetail(error, alias);
    throw Object.assign(new Error(detail || "The Existing VM did not return a valid desktop image"), {
      status: error instanceof ExistingVmError && error.code === "timeout" ? 504 : 502,
    });
  }
}

export function existingVmComputerMcp(
  cfg: AppConfig,
  control?: { url: string; token: string },
): { command: string; args: string[]; env: Record<string, string> } {
  const alias = localVmSshAlias(cfg);
  if (!alias) throw new Error("Existing VM is not configured — add an SSH config alias first");
  return {
    command: process.execPath,
    args: [SPAWNED_PROXIES.existingVmMcp, alias],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      ...(control ? { OMB_CONTROL_URL: control.url, OMB_CONTROL_TOKEN: control.token } : {}),
    },
  };
}
