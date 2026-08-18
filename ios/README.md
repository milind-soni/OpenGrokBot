# OpenMausBot companion (iOS)

Your bots keep running on the laptop. This is the phone you watch them from,
answer their approvals on, and send them the next thing.

The laptop stays the only machine that owns agent processes, credentials,
transcripts and computers. The phone owns nothing — it is a second client of the
same harness the desktop app talks to, through the restricted sidecar described in
[`docs/ios-companion.md`](../docs/ios-companion.md).

## Status

Built and verified against a real harness on both a simulator and an iPhone:
Bonjour discovery, manual LAN and Tailscale pairing, the roster, paged chat,
streaming replies, the computer view, and — the one that matters — an approval
raised by a bot on the Mac, answered on the phone, with the bot carrying on.

The event stream deliberately reads raw bytes rather than
`URLSession.AsyncBytes.lines`. Three easy-to-miss failure modes are covered by
real `URLSession` tests:

1. `timeoutInterval = .greatestFiniteMagnitude` — reads as "never time out",
   actually produces a request that opens and delivers nothing, because
   URLSession turns a timeout into a deadline by adding it to the current time.
2. Keeping only the derived line iterator while letting `URLSession.AsyncBytes`
   go out of scope. AsyncBytes cancels its data task when released, so the
   connection died the moment the first frame was returned.
3. Reading with `bytes.lines`, which folds consecutive newlines into one
   separator and therefore never reports the blank line that terminates an SSE
   event. Zero frames, no error, a healthy-looking connection at both ends.

`EventStreamTests` catches that class by driving a real `URLSession`.
[`TESTING.md`](TESTING.md) is the end-to-end runbook.

## Layout

```text
ios/
  Package.swift                  CompanionCore + its tests
  project.yml                    XcodeGen spec for the app target
  Sources/CompanionCore/         no UI, no Apple frameworks beyond Foundation
    Models.swift                 the harness's wire types
    Frames.swift                 SSE frames, unknown kinds absorbed
    SSE.swift                    line parser + URLSession event stream
    Client.swift                 every call the phone is allowed to make
    Store.swift                  the fold: frames → state
    Dictation.swift              composer text + transcript join
    Attachments.swift            composer text + host file paths
  Tests/CompanionCoreTests/
    Fixtures/                    captured from a real server — do not hand-edit
    DecodingTests.swift          the contract with the harness
    SSETests.swift               the parser, which is where this goes wrong
    StoreTests.swift             the fold
    DictationTests.swift         partials replace, they do not stack
    AttachmentTests.swift        tagged paths, escaped attributes
  App/                           SwiftUI, and everything that needs a device
    CompanionApp.swift           entry; owns when the stream lives and dies
    Session.swift                connection, lifecycle, actions
    Discovery.swift              NWBrowser for _openmausbot._tcp
    Keychain.swift               the device token
    MausAvatar.swift             the mascot face, in the desktop's palette
    PairingView.swift            find a computer, type the six digits
    ChatListView.swift           roster, with "waiting on you" pulled to the top
    ChatView.swift               transcript, approval cards, composer
    SpeechDictation.swift        SFSpeechRecognizer, press-to-stop
    ComposerAttach.swift         pending files, plus menu, chips
    CameraPicker.swift           take a photo for the composer
    ComputerView.swift           opt-in live view of a bot's computer
    MarkdownText.swift           the supported Markdown presentation layer
    SettingsView.swift           status, and unpair
```

## Building

The core needs nothing but a Swift toolchain:

```sh
cd ios
swift test
```

The app needs Xcode. The `.xcodeproj` is generated rather than committed:

```sh
brew install xcodegen
cd ios && xcodegen generate && open OpenMausCompanion.xcodeproj
```

**Re-run `xcodegen generate` once after pulling a `project.yml` change.**
`App/` is an Xcode 16 synced folder, so new Swift files in it show up on
the next build without regenerating. Quit Xcode before `git pull`, then
open the project again — pulling while it is open is what produces
"Build input files cannot be found" for `CameraPicker.swift` /
`SpeechDictation.swift`.

If you'd rather not install XcodeGen, make an iOS App target by hand, add the
`App/` folder and the local `CompanionCore` package, and copy the Info.plist
keys out of `project.yml` — `NSLocalNetworkUsageDescription` and
`NSBonjourServices` especially, plus `NSMicrophoneUsageDescription` and
`NSSpeechRecognitionUsageDescription` for the composer mic, and
`NSCameraUsageDescription` for Take Photo. Without the Bonjour pair,
`NWBrowser` returns no results at all, *silently*, which looks exactly like
"no computers on this network". Without the speech pair, the first tap on
the mic crashes rather than prompting. Without the camera string, Take Photo
does the same.

## Regenerating the fixtures

Whenever the companion API changes:

```sh
node scripts/capture-companion-fixtures.mjs   # from the repo root
```

It boots a real harness against a throwaway home directory, drives the real
pairing handshake through the sidecar, and writes down what came back. The
harness may use SQLite internally; the fixture records the public HTTP/SSE
contract, which is the only storage surface the phone should know.
Commit the diff — a change there is a change to the contract, and reviewing it
is the point.

## What the phone may and may not do

Enforced by the default-deny policy in `companion/src/routes.ts`, and mirrored
here by simply not having the methods:

| Allowed | Refused |
|---|---|
| Read bots, rooms and transcripts | Write API keys (`PUT /api/config`) |
| Send messages | Manage pairing or revoke devices |
| **Answer approvals and questions** | Drive the Local VM |
| Interrupt a bot, mark chats read | Reach `/api/internal/*` |
| Fetch screen images on demand | Load the packaged desktop UI |
| Attach a photo or file (`POST /api/inbox`) | Write bytes into the harness |

Marking a chat read and remembering an approval use purpose-built server
verbs. The sidecar does not expose the general bot or room `PATCH` routes,
because those can also change execution policy, computers, connected apps, and
working directories.

Companion settings stay on the computer on purpose: losing the phone must not
mean losing the ability to lock it out.

## Design notes

- **Zero third-party dependencies.** The raw-byte SSE reader, Keychain,
  `NWBrowser`, and notifications are all first-party.
- **Thin client.** The harness already folds provider events into settled
  messages. The phone folds `message`, `message.patch`, and `bot` frames, plus
  the small `runtime` delta subset needed to show a reply while it is typed.
- **`screens=off`.** The harness would otherwise push a base64 desktop capture
  every few seconds to a device on cellular.
- **Reconnect by cursor.** The stream is resumable: hold the `<streamId>:<seq>`
  cursor, and on reconnect the server replays what was missed or says
  `resumed: false`, which is the signal to hydrate. Lifecycle — not the parser —
  is the hard part of a phone client, which is why the stream is torn down
  deliberately on backgrounding rather than left for iOS to kill.
- **No optimistic state.** Actions call the harness and let the event stream
  deliver the result. A phone that draws its own version of what just happened
  is a phone that disagrees with the laptop.
- **Messaging-app shape, not settings-list shape.** Mascot faces at roster size,
  the bot's role as a chip beside its name, timestamps that say "Yesterday"
  rather than a date, and a gap-based separator in the transcript instead of a
  stamp on every message. The palette in `MausAvatar.swift` is copied verbatim
  from `src/lib/mascot.ts`: a bot the user knows as "the orange one" should be
  the same orange on both screens.
- **Return sends, Shift+Return breaks the line**, via `.onKeyPress`. Returning
  `.ignored` for the shifted case hands the keypress back to the text field,
  which is the only thing that can insert the newline once Return is claimed.
  Software keyboards have no Shift+Return, so there `.onSubmit` sends.
- **Composer dictation is the mic.** Tap to talk, tap to stop, then send or
  edit — the same press-to-stop shape as the desktop composer, on-device
  `SFSpeechRecognizer` when the phone supports it. The mic stays next to
  send so you can add another sentence by voice, and so you can stop
  without an Escape key. Search and the roster's "+" are real: the latter
  creates the same basic bot the desktop endpoint creates, then opens it.
- **Composer attach is a photo or a file.** Plus menu: library, camera, or
  Files. The sidecar writes the bytes onto this computer (`POST /api/inbox`)
  and the message the bot receives is the same `<attached-file path="…">`
  tag the desktop composer already sends. The harness never sees the bytes.

## Not in this version

The app is foreground-only. There is no APNs delivery while it is closed, no
call mode or spoken replies, no task-management or SQLite transcript-search UI,
and no hosted relay. Composer dictation and photo/file attach are in. Tailscale
is supported through manual MagicDNS entry; it is not a dependency and
OpenMausBot does not operate a cloud copy of local data.
