import { describe, expect, it } from "vitest";

import {
  CONTAINER,
  IMAGE,
  containerComputerStatus,
  setupCommands,
  type CommandRunner,
} from "./container-computer.ts";

function runner(responses: Record<string, string | Error>) {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    const response = responses[key];
    if (response instanceof Error || response === undefined) {
      throw response ?? new Error(`unexpected command: ${key}`);
    }
    return { stdout: response };
  };
  return { calls, run };
}

describe("containerComputerStatus", () => {
  it("prefers a running runtime over an earlier installed but stopped one", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": "podman\n",
      "docker info --format {{.ServerVersion}}": new Error("daemon stopped"),
      "podman info --format {{.ServerVersion}}": "5.0\n",
      [`podman image inspect ${IMAGE}`]: "[]",
      [`podman inspect ${CONTAINER}`]: JSON.stringify([
        {
          State: { Running: false },
          HostConfig: {
            PortBindings: {
              "5900/tcp": [{ HostIp: "127.0.0.1" }],
              "6080/tcp": [{ HostIp: "127.0.0.1" }],
            },
          },
        },
      ]),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.runtime).toBe("podman");
    expect(status.available).toEqual(["docker", "podman"]);
    expect(status.daemonUp).toBe(true);
    expect(status.image).toBe(true);
    expect(status.container).toBe("stopped");
    expect(status.network).toBe("loopback");
  });

  it("uses Apple container's actual system and inspect commands", async () => {
    const fake = runner({
      "/usr/bin/which docker": new Error("missing"),
      "/usr/bin/which podman": new Error("missing"),
      "/usr/bin/which container": "container\n",
      "container system status": "running\n",
      [`container image inspect ${IMAGE}`]: "[]",
      [`container inspect ${CONTAINER}`]: JSON.stringify([
        {
          configuration: {
            publishedPorts: [
              { hostAddress: "127.0.0.1", containerPort: 5900 },
              { hostAddress: "127.0.0.1", containerPort: 6080 },
            ],
          },
          status: { state: "running" },
        },
      ]),
    });

    const status = await containerComputerStatus(fake.run, "darwin");

    expect(status.runtime).toBe("container");
    expect(status.container).toBe("running");
    expect(status.network).toBe("loopback");
    expect(fake.calls).not.toContain("container info --format {{.ServerVersion}}");
  });

  it("does not report a running container as ready when a desktop port is public", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "27\n",
      [`docker image inspect ${IMAGE}`]: "[]",
      [`docker inspect ${CONTAINER}`]: JSON.stringify([
        {
          State: { Running: true },
          HostConfig: {
            PortBindings: {
              "5900/tcp": [{ HostIp: "0.0.0.0" }],
              "6080/tcp": [{ HostIp: "127.0.0.1" }],
            },
          },
        },
      ]),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.container).toBe("running");
    expect(status.network).toBe("unsafe");
  });

  it("does not mistake an unrelated container executable for Apple container off macOS", async () => {
    const fake = runner({
      "where.exe docker": new Error("missing"),
      "where.exe podman": new Error("missing"),
    });

    const status = await containerComputerStatus(fake.run, "win32");

    expect(status.runtime).toBeNull();
    expect(fake.calls).not.toContain("where.exe container");
  });
});

describe("setupCommands", () => {
  it("does not invent Docker commands when no runtime was detected", () => {
    const commands = setupCommands(null, "darwin");
    expect(commands.pull).toBeNull();
    expect(commands.run).toBeNull();
    expect(commands.start).toBeNull();
    expect(commands.install).toContain("podman");
    expect(commands.install).not.toContain("Docker");
  });

  it("publishes VNC ports only on the loopback interface", () => {
    const commands = setupCommands("podman", "linux");
    expect(commands.run).toContain("-p 127.0.0.1:6080:6080");
    expect(commands.run).toContain("-p 127.0.0.1:5900:5900");
    expect(commands.run).not.toContain(" -p 6080:6080");
  });

  it("generates Apple container lifecycle commands without Docker-only flags", () => {
    const commands = setupCommands("container", "darwin");
    expect(commands.runtimeStart).toBe("container system start");
    expect(commands.remove).toBe(`container rm --force ${CONTAINER}`);
  });

  it("offers the supported Podman Desktop installer on Windows", () => {
    expect(setupCommands(null, "win32").install).toBe(
      "winget install -e --id RedHat.Podman-Desktop",
    );
  });
});
