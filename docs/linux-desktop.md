# Ubuntu Desktop

OpenMausBot has an Ubuntu 24.04 LTS x86_64 desktop beta. The Electron package embeds the harness server, so
installed builds do not require Node, pnpm, Swift, or a terminal at runtime.

## What works

- The native Electron window and embedded OpenMausBot server on GNOME Xorg and GNOME Wayland.
- Local Claude, Codex, Grok, Gemini, and other configured agent CLIs.
- Chat, streaming turns, approvals, bot-to-bot communication, and local data storage.
- Composio connected apps and Box cloud computers.
- External documentation and OAuth links in the default browser.

The first beta intentionally does **not** claim Linux dictation, local screen preview, or control of this
computer. Those controls are unavailable in the UI and fail closed in the Electron and server layers. Use a
Cloud box when a bot needs a computer. Xorg computer control, Wayland validation, bundled CUA, dictation, and
ARM64 are follow-ups in [issue #29](https://github.com/milind-soni/OpenMausBot/issues/29).

## Build packages

Requirements for building from source:

- Ubuntu 24.04 LTS x86_64
- Node.js 24 or newer
- pnpm 10.33.0 (Corepack can install the version declared by the project)

```sh
git clone https://github.com/milind-soni/OpenMausBot.git
cd OpenMausBot
corepack enable
pnpm install --frozen-lockfile
pnpm package:linux
```

The build creates:

- `release/OpenMausBot-<version>-amd64.deb`
- `release/OpenMausBot-<version>-x86_64.AppImage`

The AppImage uses a static runtime and does not require the legacy `libfuse2` package.

## Install and run

Install the Debian package with APT so its desktop dependencies are resolved:

```sh
sudo apt install ./release/OpenMausBot-*-amd64.deb
```

Then open **OpenMausBot** from the GNOME application launcher. To remove it:

```sh
sudo apt remove openmausbot
```

The portable AppImage does not install system files:

```sh
chmod +x release/OpenMausBot-*-x86_64.AppImage
./release/OpenMausBot-*-x86_64.AppImage
```

Application data remains local in `~/.openmausbot`. Electron browser data and window state use the normal XDG
configuration directory (`~/.config/openmausbot` unless the environment overrides it).

## Develop the desktop shell

Development mode uses three processes. Keep each command running in its own terminal:

```sh
pnpm dev:server
pnpm dev
pnpm dev:desktop
```

For a package-shaped build without creating `.deb` or AppImage artifacts:

```sh
pnpm package:linux:dir
./release/linux-unpacked/openmausbot
```

## Agent CLI discovery

Applications launched from GNOME do not inherit the same interactive shell `PATH` as a terminal. OpenMausBot
keeps the inherited path and adds existing common locations such as:

- `~/.local/bin`
- `~/.claude/local`
- `~/.volta/bin`
- `~/.bun/bin`
- `~/.asdf/shims`
- `~/.deno/bin`
- `~/.nvm/versions/node/*/bin`
- `/usr/local/bin`

It also probes the login shell in the background. If a CLI still is not detected, set an explicit additional
path before launching the app from a terminal and verify it there:

```sh
OMB_EXTRA_PATH=/your/custom/bin ./release/OpenMausBot-*-x86_64.AppImage
```

Restart OpenMausBot after installing or signing in to a CLI.

## Xorg and Wayland

The baseline shell, chat, cloud computers, and connected apps work in both GNOME session types. OpenMausBot
detects Wayland before XWayland when both `WAYLAND_DISPLAY` and `DISPLAY` exist, so future capture features do
not accidentally bypass portal-mediated behavior.

Local computer control remains disabled on both session types in this beta. Future Xorg support will require a
validated `cua-driver`; Wayland support will remain disabled until the exact GNOME/Mutter action surface has
real capture, input, scaling, permission, and lifecycle evidence.

## Validate a package change

```sh
pnpm typecheck
pnpm test
pnpm check:electron
pnpm package:linux
node scripts/verify-linux-package.mjs
dbus-run-session -- xvfb-run -a node scripts/smoke-linux-package.mjs
```

The verifier checks `.deb` metadata, desktop identity, resources, artifact permissions, and the absence of
unsupported native binaries. The smoke test launches the unpacked production app without `--no-sandbox`,
validates the renderer/preload capabilities and embedded health endpoint, then proves clean shutdown. It is not
a substitute for manual testing on a real GNOME Xorg and Wayland desktop.

## Troubleshooting

### An agent CLI is missing

Run the CLI directly in a terminal, finish its sign-in flow, then restart OpenMausBot. If it lives outside the
common directories above, use `OMB_EXTRA_PATH` while testing and report the install location so it can be
considered for automatic discovery.

### A bot needs computer tools

Choose **Cloud box** in the Computer panel and add a Box token in App Settings. **This computer** is disabled on
Linux until local CUA control is implemented and validated.

### The AppImage does not start

Confirm the executable bit and architecture:

```sh
chmod +x OpenMausBot-*-x86_64.AppImage
file OpenMausBot-*-x86_64.AppImage
```

Run it from a terminal once to collect the startup output. Do not install `libfuse2` just for this AppImage; the
package is built with the static runtime.
