# iOS companion architecture

The iOS app is a thin, native client for the OpenMausBot instance running on
your Mac. The Mac remains the only machine that owns agent processes,
credentials, SQLite data, transcripts, and computers. The phone discovers or
is told how to reach the Mac, pairs once, and then uses the same HTTP and SSE
contract as the desktop client through a restricted sidecar.

## Current status

The first version includes:

- Bonjour discovery on the same LAN and manual address entry.
- Remote access through a Tailscale MagicDNS name.
- One-time pairing codes, per-device tokens, device listing, and revocation.
- Bot and room lists, paged transcripts, sending, interruption, and unread
  state.
- Approvals and questions, including narrow “always allow” grants.
- Resumable SSE, streamed reply text, reconnect hydration, and an opt-in live
  computer view.
- Markdown rendering and Keychain storage for the device token.

It is foreground-only. Push notifications, background delivery, voice, App
Store release automation, and a hosted relay are not part of this version.

## Runtime architecture

```text
 iPhone
   SwiftUI UI + CompanionCore
   bearer token in Keychain
            │
            │ HTTP + resumable SSE
            │ LAN or Tailscale
            ▼
 companion sidecar :8810
   pairing authentication
   default-deny route allowlist
   response and SSE scrubbing
            │
            │ loopback only
            ▼
 OpenMausBot harness :8799
   HTTP API + event stream
   agent processes and approvals
            │
            ▼
 SQLite message store + local configuration
```

There are three deliberately separate trust surfaces:

| Surface | Bind | Purpose |
|---|---|---|
| Harness | `127.0.0.1:8799` | Existing app API; remains loopback-only |
| Companion | `0.0.0.0:8810` | Paired native devices; authenticated and allowlisted |
| Companion control | `127.0.0.1:8811` | Start pairing, cancel pairing, list devices, revoke |

The desktop app owns the sidecar lifecycle through
`electron/companion.mjs`. The renderer only receives narrow IPC operations; it
does not fetch the control port directly.

## SQLite compatibility

SQLite does not move onto the phone. It is an implementation detail behind the
harness API:

- `server/message-db.ts` and `server/store.ts` persist and page transcripts.
- The phone asks for `GET /api/bots?messages=50` and
  `GET /api/threads/:threadId/messages?before=…&limit=50`.
- SQLite ordering and cursors are therefore tested at the server boundary,
  while the Swift package tests decoding and prepend/deduplication using
  responses captured through the real sidecar.
- A storage migration may change the bytes on disk without changing the app.
  If an API payload changes, regenerate the fixtures with
  `node scripts/capture-companion-fixtures.mjs` and review the diff.

The sidecar keeps its device registry in `~/.openmausbot/devices.json`. That is
security state owned by the network boundary, not transcript data, so it does
not belong in the message database.

## Connectivity

### Same Wi-Fi

The sidecar advertises `_openmausbot._tcp` over Bonjour. The app browses with
`NWBrowser`, resolves the chosen service, and connects directly. If multicast
is unavailable, the desktop shows the LAN address for manual entry.

LAN traffic is plain HTTP. Use it only on a network you trust. Pairing tokens
are bearer credentials, so someone able to observe that LAN traffic could copy
one until the device is revoked.

### Tailscale

Tailscale is the recommended route away from home and on Wi-Fi networks that
isolate clients. Both devices join the same tailnet and the phone uses the
Mac’s MagicDNS name, such as `macbook.example.ts.net:8810`.

The URL is still `http`, but the path is encrypted and authenticated by
WireGuard inside the tailnet. Use the MagicDNS name rather than the
`100.64.0.0/10` address: App Transport Security exceptions are domain-based,
and `ios/project.yml` narrowly allows insecure HTTP for `ts.net` subdomains.
Bonjour does not cross the tailnet, so remote pairing uses manual address
entry.

Tailscale is optional. There is no OpenMausBot-operated relay or cloud copy of
the local data in this design.

## Pairing and device security

1. The user enables Companion in desktop Settings.
2. The desktop opens a short-lived six-digit pairing window.
3. The phone sends the code and a device name to `POST /api/pair`.
4. The sidecar returns a random device token once and stores only its SHA-256
   digest.
5. The phone stores the token in Keychain and sends it as a bearer token.
6. Revoking the device on the Mac invalidates future requests and sends the
   phone back to pairing.

The device-facing socket rejects browser `Origin` headers before reading a
token. Its route policy in `companion/src/routes.ts` is default-deny: a new
harness route remains unreachable until it is deliberately added.

Allowed in the first release:

- Read the fleet, rooms, instances, configuration status, and transcripts.
- Fetch settled screen images and opt into live screen frames.
- Send messages, interrupt bots, answer approvals/questions, and mark chats
  read.
- Create a basic bot.

The write surface uses purpose-built `read` and `always-allow` endpoints. The
general bot and room `PATCH` endpoints are not reachable through the sidecar.
An always-allow request succeeds only when its server-issued key is still on a
pending approval for that bot, so possession of a device token is not enough
to invent a broad execution grant.

Intentionally refused:

- API keys and provider configuration.
- Pairing, device revocation, or companion lifecycle control.
- Local VM lifecycle, webhooks, connectors, routines, team import/export, and
  internal peer-agent routes.
- New harness routes that have not been reviewed for phone access.

## Stream and state model

`CompanionCore` contains the wire models, client, raw-byte SSE parser, and pure
state fold. The SwiftUI target owns lifecycle and presentation only.

On connection, the server sends a `hello` frame containing a cursor and whether
the requested gap was replayed. The client:

1. resumes from its last `<streamId>:<seq>` cursor;
2. folds replayed and live frames when the gap is available;
3. hydrates the newest page of each visible conversation when it is not; and
4. paginates older transcript pages on demand.

Unknown message and frame kinds degrade safely instead of failing an entire
response, and one malformed fleet record does not hide every healthy chat.
Screen frames are off by default and enabled only while a computer view is
visible. Backgrounding deliberately closes the stream; foregrounding
reconnects from the saved cursor. A hello cursor is committed only after a
cold hydration succeeds; replayed streams advance it one folded frame at a
time, so a disconnect during recovery cannot skip the remaining gap.

## Source layout

```text
companion/
  src/routes.ts       device-facing allowlist
  src/devices.ts      pairing and token registry
  src/proxy.ts        HTTP/SSE forwarding and scrubbing
  src/control.ts      loopback-only control plane
  src/mdns.ts         Bonjour advertisement

ios/
  Sources/CompanionCore/   models, HTTP, SSE, state fold
  Tests/CompanionCoreTests/ captured-contract and core tests
  App/                     SwiftUI, lifecycle, discovery, Keychain
  project.yml              generated Xcode project specification
```

## Verification contract

The merge gate for this feature is:

```sh
pnpm typecheck
pnpm test
pnpm build:companion
pnpm check:electron

cd ios
swift test
xcodegen generate
xcodebuild -project OpenMausCompanion.xcodeproj \
  -scheme OpenMausCompanion \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

The simulator validates compilation, launch, layout, manual address parsing,
and failure states. Bonjour, Local Network permission, Tailscale routing,
Keychain behavior across a reboot, and approval delivery still require a real
iPhone pass.

## Follow-on releases

Keep the foundational merge separate from capabilities that widen security or
distribution scope:

1. **Foundation:** sidecar, desktop controls, Swift core/app, pairing, chat,
   approvals, reconnect, simulator and contract CI.
2. **Current desktop parity:** task switching/creation, SQLite search, transcript
   export/share, and explicit handling for archived or hidden chats.
3. **Notifications:** APNs credentials, a relay or another wake-up design,
   notification actions, and background reconciliation.
4. **Distribution:** signing, bundle ownership, privacy declarations,
   TestFlight, and App Store review material. Swift tests and an unsigned
   simulator build already run in the repository CI.
5. **Optional expansion:** voice/call mode, richer computer interaction, or a
   hosted relay. Each requires its own threat-model review.
