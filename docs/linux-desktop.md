# Ubuntu Desktop

OpenMausBot has an Ubuntu 24.04 LTS x86_64 desktop beta. The Electron package embeds the harness server, so
installed builds do not require Node, pnpm, Swift, or a terminal at runtime. For giving a bot the same kind
of Linux desktop on your own server instead of this machine, see [byo-vps.md](byo-vps.md).

## What works

- The native Electron window and embedded OpenMausBot server on GNOME Xorg and GNOME Wayland.
- Local Claude, Codex, Grok, Gemini, and other configured agent CLIs.
- Chat, streaming turns, approvals, bot-to-bot communication, and local data storage.
- Composio connected apps and Box cloud computers.
- External documentation and OAuth links in the default browser.
- An explicit, view-only local screen preview on GNOME Xorg and GNOME Wayland. The Wayland path uses the
  native portal chooser and keeps the selected PipeWire stream open until the user stops sharing.
- A fail-closed Linux local-control state while the real-seat input-safety blocker in issue #345 is resolved.

The local preview does **not** give the bot control of this computer by itself. Linux local control is temporarily
disabled and legacy opt-ins are cleared automatically; do not start the bundled driver manually as a workaround.
Automatic Wayland helper installation, Linux dictation, and ARM64 remain unavailable and fail closed; follow their
progress in [issue #29](https://github.com/milind-soni/OpenMausBot/issues/29) and the safety hold in
[issue #345](https://github.com/milind-soni/OpenMausBot/issues/345). Bundled
CUA supply-chain work is tracked in [issue #113](https://github.com/milind-soni/OpenMausBot/issues/113). Xorg is tracked in
[issue #79](https://github.com/milind-soni/OpenMausBot/issues/79), and guarded GNOME/Wayland support in
[issue #109](https://github.com/milind-soni/OpenMausBot/issues/109).

## Download packages

Choose one Ubuntu 24.04 x86_64 package from the latest release:

- [Debian package (`OpenMausBot-amd64.deb`)](https://github.com/milind-soni/openmausbot-releases/releases/latest/download/OpenMausBot-amd64.deb) — recommended; APT installs its desktop dependencies.
- [Portable AppImage (`OpenMausBot.AppImage`)](https://github.com/milind-soni/openmausbot-releases/releases/latest/download/OpenMausBot.AppImage) — does not install system files.
- [SHA-256 checksums](https://github.com/milind-soni/openmausbot-releases/releases/latest/download/SHA256SUMS-ubuntu-x64.txt)

Versioned packages and previous releases remain available on the
[releases page](https://github.com/milind-soni/openmausbot-releases/releases).

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

Install a downloaded Debian package with APT so its desktop dependencies are resolved:

```sh
sudo apt install ./OpenMausBot-amd64.deb
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

For a downloaded release AppImage, use `OpenMausBot.AppImage` in place of the versioned path above.

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

The shell, chat, cloud computers, connected apps, and preview-only capture work in both GNOME session types.
The Wayland chooser/select/persistent-stream/cancel/end/retry lifecycle has been validated in a real Ubuntu
24.04 GNOME Wayland session. OpenMausBot detects Wayland before XWayland when both `WAYLAND_DISPLAY` and
`DISPLAY` exist, so capture cannot accidentally bypass portal-mediated behavior.

Open the Computer panel and use the separate **Preview this computer** card. Capture never starts when the app
or panel opens.

- **Xorg:** **Start preview** captures the primary monitor directly.
- **Wayland:** **Choose a screen** opens the GNOME portal chooser once. The selected stream stays open until
  you press **Stop preview**, close the panel, end sharing from GNOME, or quit the app.

Cancelling or ending Wayland sharing returns to a calm **Try again** state and never reopens the chooser
automatically. OpenMausBot does not capture screen audio, remember the selected monitor after restart, or
offer an **Open Settings** action on Linux.

Local computer control is independent from preview and currently fails closed on both sessions. The app never
starts Cua from a legacy preference. XWayland's `DISPLAY` never bypasses this release safety hold.

## Local control safety hold

Installed `.deb` and AppImage builds include the certified **Cua Driver 0.19.3** CLI and cursor-theme sidecar.
The app deliberately does not start that runtime while #345 is open: real GNOME/Xorg validation found that merely
starting it could capture the physical pointer and keyboard before an approved action. Xvfb readiness, a successful
handshake, and driver diagnostics do not prove that human-input boundary safe. The UI reports the safety hold,
**This computer** remains unavailable, and an older persisted opt-in is reset to off with private file permissions.

There is no supported manual enable flow during this hold. Continue using Chat, preview-only capture, Cloud, or
Local VM. Re-enablement requires evidence on real GNOME/Xorg and GNOME/Wayland seats; it will not be controlled by
an environment override.

The upstream release has no signature or GitHub artifact attestation and is not immutable, so the build uses an
explicit reviewed digest as its trust anchor:

- source commit: `a1672e7b11951275ecfba3384264d4530185d0db`;
- archive SHA-256: `3db9d4257d84bacaf7eb104d225f85613ce67edbb20d6eeb83c1384b6d8a5b10`;
- packaged driver SHA-256: `ed5844fadf07b9b72c4a3b3802e1c47233c166d66d6198608d5991f807aab4ac`;
- packaged cursor-theme SHA-256: `e589b2b7521bbfeaf9e2bfce668a38e80ed1b9790b1327b13d374fc331d8312a`.

Packaging verifies the exact archive size, checksum, member names/types/sizes, and inner hashes before extracting
only those two executables. The app performs no runtime driver download or self-update. Cua's MIT license, the
embedded Inter font's SIL OFL 1.1 notice, full dependency license texts, MPL source locations, and a CycloneDX
inventory ship beside the binary; the reviewed source records live in [`third_party/cua-driver`](../third_party/cua-driver/).
The reviewed native runtime adds roughly 11–13 MiB to a compressed Ubuntu artifact. The ELF
requires glibc 2.30 or newer plus the standard Ubuntu X11/XInput/xkbcommon libraries already present on the supported
Ubuntu 24.04 desktop; the package verifier executes the exact binary from every artifact layout.

AppImage's pinned SquashFS toolchain can emit root-owned directories as `0755` or `0775`; the package verifier
requires one of those modes consistently across the reviewed resource tree. The dormant runtime retains a private
`0700` staging design for a future re-enabled AppImage, while the current release hold prevents copying or executing
either binary. DEB upgrades repair their exact package-owned path to `root:root 0755` automatically.

The packaged runtime remains outside ASAR only for deterministic provenance and future validation. Neither a
`CUA_DRIVER_PATH` value nor an ambient PATH candidate bypasses the current release hold.

The dormant runtime code retains private sockets, standard permission mode, per-action OpenMausBot approvals,
telemetry/update-check suppression, strict driver identity, and lifecycle cleanup tests. Those defenses remain
necessary, but none substitutes for the real-seat acceptance evidence required to remove the safety hold. Linux
**Auto** never routes to the user's desktop, and no Cloud or Local VM approval can authorize it.

## Validate a package change

```sh
pnpm typecheck
pnpm test
pnpm check:electron
pnpm build:cua:linux          # networked, checksum-pinned staging
pnpm package:linux:offline    # CUA staging is offline; builder caches must already be available
node scripts/verify-linux-package.mjs
pnpm smoke:linux-package
```

The verifier checks `.deb` metadata, desktop identity, the exact dormant Cua resource tree and provenance,
SquashFS/DEB directory modes, runtime path policy, and matching binary hashes across all artifacts. The local smoke
launches the unpacked app and AppImage without `--no-sandbox`; CI first reproduces a `0.1.7` in-place DEB upgrade and
then runs the same smoke against `/opt/OpenMausBot/openmausbot`. These lanes prove the embedded server and UI are
usable while an optional Composio broker stalls, verify that an old local-control opt-in is cleared, and assert that
no Cua executable starts on Xorg or simulated Wayland. Low-level runtime tests retain the future private-daemon
contract without activating it in a packaged app. Only a real-seat acceptance matrix can authorize re-enablement.

## Troubleshooting

### An agent CLI is missing

Run the CLI directly in a terminal, finish its sign-in flow, then restart OpenMausBot. If it lives outside the
common directories above, use `OMB_EXTRA_PATH` while testing and report the install location so it can be
considered for automatic discovery.

### A bot needs computer tools

Choose **Cloud box** and add a Box token in App Settings, or use Local VM. Linux **This computer** remains disabled
under the input-safety hold; it has no supported manual workaround.

### Local control is not ready

The in-app card should say that Linux local control is temporarily unavailable. If it instead offers **Enable local
control**, close the app and report the package version on #345; do not click it or run the bundled driver manually.
An upgraded DEB repairs its own package directory modes automatically—no user `chmod` is required.

### Screen preview does not start

On Xorg, confirm the session has an active display with `echo "$XDG_SESSION_TYPE"`; it should print `x11`.
On Wayland, confirm `xdg-desktop-portal` and the GNOME portal backend are running, then click **Try again** to
open a new chooser. Cancelling or stopping sharing never causes an automatic second prompt.

### The AppImage does not start

Confirm the executable bit and architecture:

```sh
chmod +x OpenMausBot-*-x86_64.AppImage
file OpenMausBot-*-x86_64.AppImage
```

Run it from a terminal once to collect the startup output. Do not install `libfuse2` just for this AppImage; the
package is built with the static runtime.
