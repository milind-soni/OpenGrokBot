// Pure desktop capability detection shared by Electron main tests and the
// renderer contract. Keep this file free of Electron imports so every branch
// is deterministic and unit-testable.

const DESKTOP_PLATFORMS = new Set(["darwin", "linux", "win32"]);

function normalizedPlatform(platform) {
  return DESKTOP_PLATFORMS.has(platform) ? platform : "other";
}

function linuxSession(platform, env) {
  if (platform !== "linux") return "unknown";
  const declared = String(env.XDG_SESSION_TYPE ?? "").toLowerCase();
  if (declared === "wayland") return "wayland";
  if (declared === "x11" || declared === "xorg") return "x11";
  // A Wayland user session may also expose DISPLAY for XWayland. Prefer the
  // Wayland signal so the UI never bypasses portal-mediated behavior.
  if (env.WAYLAND_DISPLAY) return "wayland";
  if (env.DISPLAY) return "x11";
  return "headless";
}

function localComputerReady(platform, connection) {
  return (
    platform === "darwin" &&
    (connection?.mode === "embedded" || connection?.mode === "standalone")
  );
}

function desktopCapabilities({
  platform = process.platform,
  env = process.env,
  packaged = false,
  localConnection = null,
} = {}) {
  const hostPlatform = normalizedPlatform(platform);
  const isMac = hostPlatform === "darwin";
  const localAvailable = localComputerReady(hostPlatform, localConnection);

  return {
    host: {
      platform: hostPlatform,
      label:
        hostPlatform === "darwin"
          ? "macOS"
          : hostPlatform === "linux"
            ? "Linux"
            : hostPlatform === "win32"
              ? "Windows"
              : "Desktop",
      session: linuxSession(hostPlatform, env),
      packaged: Boolean(packaged),
    },
    windowChrome: isMac ? "mac-inset" : "native",
    screenPreview: {
      available: isMac,
      interaction: isMac ? "direct" : "none",
      ...(!isMac ? { reasonCode: "unsupported-platform" } : {}),
    },
    dictation: {
      available: isMac,
      engine: isMac ? "apple-speech" : "none",
      onDevice: isMac,
      ...(!isMac ? { reasonCode: "unsupported-platform" } : {}),
    },
    localComputer: {
      available: localAvailable,
      support: localAvailable ? "supported" : "unsupported",
      ...(!localAvailable
        ? {
            reasonCode:
              hostPlatform === "darwin" ? "cua-driver-unavailable" : "unsupported-platform",
          }
        : {}),
    },
  };
}

module.exports = { desktopCapabilities, linuxSession, localComputerReady };
