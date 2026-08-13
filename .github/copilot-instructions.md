# OpenMausBot — Copilot instructions

A macOS Electron chat app where every "bot" in the sidebar is a real agent (the `claude`,
`codex`, `grok`, or `gemini` CLI installed on the user's machine) driven by a local harness
server. Read [`server/contracts.ts`](../server/contracts.ts) first — it is the whole
architecture in one file.

## Commands

Requires **Node 24+** and **pnpm** (`packageManager: pnpm@10.33.0`). There is no linter —
`tsc` with `strict` + `noUnusedLocals` + `noUnusedParameters` is the lint gate.

```sh
pnpm install                 # ELECTRON_SKIP_BINARY_DOWNLOAD=1 skips the Electron download (CI does this)
pnpm dev:server              # harness server → 127.0.0.1:8799
pnpm dev                     # Vite app → 127.0.0.1:5199 (proxies /api to the harness)
pnpm dev:desktop             # Electron shell (expects both of the above running)

pnpm typecheck               # app (tsconfig.json) + server (tsconfig.server.json)
pnpm test                    # vitest, server/**/*.test.ts only
pnpm test server/harness/bus.test.ts                       # one file
pnpm exec vitest run server/drivers/claude.test.ts -t "decodeConfig"   # one test by name
pnpm build                   # typecheck + vite build
pnpm package                 # full macOS .dmg via electron-builder (signing/notarization)
```

CI (`.github/workflows/ci.yml`) runs `pnpm typecheck && pnpm test` on macOS, Ubuntu, and
Windows — the Windows leg is the guardrail for portability, and POSIX-only tests self-skip
there. **`pnpm typecheck && pnpm test` must pass before any PR.**

## Architecture

Two processes, one canonical event stream.

- **Harness server** (`server/`, plain Node `http`, no framework) owns *every* agent process.
  `ProviderRegistry` turns the config map into live `ProviderInstance`s; `EventBus` fans every
  adapter's events into one stream.
- **App** (`src/`, React 19 + Tailwind 4) holds **no transports of its own**: it dispatches
  typed commands over HTTP and folds one SSE stream (`GET /api/events`) into a single reducer
  in `src/state/store.tsx`.
- **Electron** (`electron/`, plain `.mjs`) is the macOS shell: dictation, screen capture, the
  `cua-driver` daemon, auto-updates. Packaged, it forks the compiled `dist-server` on Electron's
  own Node and serves the built UI from one origin (no dev proxy).

Rules that hold the design together:

- **Drivers normalize, never invent.** Each `server/drivers/*.ts` flattens a provider's native
  protocol (Claude stream-JSON, Codex JSON-RPC app-server, ACP) into the canonical
  `RuntimeEvent` union in `contracts.ts`. The bus **drops any event whose `provider` doesn't
  match the emitting instance's `driverKind`**.
- **The event stream is the source of truth.** The persisted transcript (`~/.openmausbot/messages-<threadId>.json`)
  and every client view are projections folded from it in `server/index.ts`. Events are also
  tee'd to per-thread NDJSON in `~/.openmausbot/events/` — read those when debugging a turn.
- **Unknown or broken configs degrade to a shadow, never a crash.** `decodeConfig` *throws* on
  invalid config and `create` *rejects* (never throws synchronously); the registry turns both
  into an `unavailable` shadow snapshot so a config written by a newer build round-trips
  safely. Do not "fix" this by validating driver slugs up front.
- **`~/.openmausbot/`** holds everything: `config.json` (keys), `bots.json` (bot records,
  thread→instance binding, per-instance `resumeCursors`), `routines.json` (scheduled turns),
  transcripts, event logs.

## Conventions

**Imports.** Server code imports relative paths **with the `.ts` extension** (`from "./config.ts"`)
— it runs under Node type-stripping in dev and `rewriteRelativeImportExtensions` at build. App
code uses the `@/` alias for `src/`.

**Never build command strings for a shell.** No `shell: true`, no `cmd.exe` quoting — model
names, personas, and MCP config JSON travel through `argv`. Every agent-CLI spawn goes through
`augmentedPath()` (`server/env-path.ts`), which repairs the bare PATH a Finder-launched app
inherits.

**Platform gating.** `server/` must stay portable Node. macOS-only code (TCC, Swift helpers,
`~/Library`) belongs in `electron/` behind `process.platform === "darwin"`. POSIX-only calls
need a gated Windows equivalent, not a silent failure.

**Secrets are write-only.** Keys land in `config.json` via `PUT /api/config`; the API only ever
reports `configured` booleans. Never log, echo, or bake a key into argv.

**`dist-server/` is build output** — never hand-edit it and never include it in a PR.

**Adding a provider** = one file in `server/drivers/` implementing `ProviderDriver` + one line in
`builtIn.ts`, plus a contract test. A missing CLI must surface as
`snapshot() → { state: "unavailable", reason }` and a failed spawn as a failed turn — never a
hang, never a crash.

**Permissions and asks** reach the user as `request.opened` events rendered as inline cards.
Claude gets them via the MCP stdio broker in `server/permission-proxy.ts` (its **stdout is the
MCP channel — never `console.log` there**).

**Peer comms are depth-capped.** A user-initiated turn is depth 0 and may get the `agents` MCP
tools; a turn invoked through `ask_bot` runs at depth 1 with no agents tools, so A→B works but
B→C and A→B→A loops never start (`MAX_COMMS_DEPTH` in `server/index.ts`).

**Routines are turns, not a side channel.** A scheduled routine (`server/routines.ts`) fires through
the same `startTurn` as a typed message, so it inherits the permission broker, event bus, and
transcript. Schedule math is pure and lives in `routines.ts`; the ticking scheduler lives in
`index.ts` and advances the clock *before* running, so a slow or failing turn can't hot-loop.

**UI** uses Tailwind v4 with the palette defined as `@theme` tokens in `src/styles.css` (e.g.
`bg-panel`, `text-ink-secondary`, `text-accent`) — use the tokens, not raw hex. Compose classes
with `cn()` from `@/lib/cn`. UI PRs need before/after screenshots.

## Tests

Colocated as `server/**/*.test.ts`; `vite.config.ts` sets `fileParallelism: false` because the
suite spawns real processes. Three layers: unit (registry, bus, store — use
`server/testing/fake-driver.ts`), driver contract (spawns the scripted fake CLIs in
`server/testing/`, failure modes toggled by env var such as `FAKE_CLAUDE_MODE=exit-early`), and
API smoke (`server/index.test.ts` boots the real server).

- **No sleeps.** Wait on the event that proves the behavior via `recordEvents(adapter).until(...)`
  from `server/testing/events.ts`. A test that needs a timeout to pass is wrong.
- **Never touch the real `~/.openmausbot`** — `server/testing/setup.ts` points `HOME`/`USERPROFILE`
  at a temp dir; keep it that way.
- Tests that spawn a shebang script are gated `describe.skipIf(process.platform === "win32")`.
- Extend the fake CLIs rather than mocking `child_process`.
