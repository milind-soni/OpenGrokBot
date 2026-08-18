// The app's one long-lived object: who we are paired with, what we know,
// and the stream that keeps it current.
//
// The parsing and folding live in CompanionCore. What lives here is the
// part that cannot be unit-tested and is the actual hard problem in a phone
// client — lifecycle. A phone loses its connection constantly: it locks, it
// backgrounds, it moves between wifi and cellular. So the stream is torn
// down deliberately when the app leaves the screen, and on the way back the
// server is asked what was missed rather than being asked for everything.
import Foundation
import OSLog
import SwiftUI
import CompanionCore
import UserNotifications
import UIKit

/// Stream lifecycle, in Console.app and the Xcode console. A companion that
/// is silently not connected looks exactly like one with nothing to say, so
/// the transitions are worth being able to read.
private let log = Logger(subsystem: "com.openmausbot.companion", category: "stream")

@MainActor
final class Session: ObservableObject {
    enum Status: Equatable {
        case unpaired
        case connecting
        case live
        /// The token stopped working — revoked on the computer, most likely.
        case unauthorized
        case offline(String)
    }

    @Published private(set) var state = CompanionState()
    @Published private(set) var connection: Connection?
    @Published private(set) var status: Status = .unpaired
    /// Transient, user-facing failures from an action they just took.
    @Published var actionError: String?
    /// One exact message the next opened chat should reveal.
    @Published private(set) var focusedMessageId: String?
    @Published private(set) var notificationAuthorization: UNAuthorizationStatus = .notDetermined
    /// A short-lived desktop handoff waiting for PairingView to present it.
    @Published private(set) var pairingInvite: PairingInvite?

    private var client: CompanionClient?
    /// The device token, kept in memory so the client can be rebuilt when the
    /// dial moves to another stored host. The keychain remains the only place
    /// it is persisted.
    private var token: String?
    /// Which of the connection's stored hosts the next attempt dials. The
    /// walk advances on address-shaped failures and the winner is promoted —
    /// and persisted — when a stream goes live.
    private var rotation = CandidateRotation(hosts: [])
    private var streamTask: Task<Void, Never>?
    /// Identifies the task currently stored in `streamTask`. A cancelled task
    /// can finish after its replacement starts; its cleanup must not clear
    /// the replacement's handle.
    private var streamGeneration = 0
    private var reconnectDelay: UInt64 = 0
    /// How many computer panels are open. A count rather than a flag: the
    /// panel can be pushed twice in a navigation stack, and the last one to
    /// close is the one that should turn screens back off.
    private var screenWatchers = 0
    /// A saved connection exists, but its token could not be read yet. Keeps
    /// "the keychain is locked" from being mistaken for "not paired".
    private var restorePending = false

    private static let connectionKey = "companion.connection"

    // MARK: - Pairing

    init() {
        _ = NotificationCoordinator.shared
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-store-preview"),
           let url = Bundle.main.url(forResource: "StorePreview", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let fleet = try? JSONDecoder().decode(Fleet.self, from: data) {
            connection = Connection(name: "Preview Mac", host: "preview.tailnet.ts.net", port: 8810)
            state.hydrate(fleet)
            status = .live
            return
        }
#endif
        restore()
        Task { await refreshNotificationAuthorization() }
    }

    /// Rebuild the last connection at launch.
    ///
    /// Three outcomes, and keeping them apart is the whole point. No saved
    /// connection: stay unpaired. A saved connection whose token reads back:
    /// connect. A saved connection whose token cannot be read *yet* — the
    /// locked keychain before a phone's first unlock after reboot, which is
    /// when iOS is most likely to have launched us in the background — hold
    /// on to it and try again. Only the middle case is a real pairing, and
    /// only the first should ever send someone back to the pairing screen.
    private func restore() {
        restorePending = false
        guard let data = UserDefaults.standard.data(forKey: Self.connectionKey),
              let saved = try? JSONDecoder().decode(Connection.self, from: data)
        else { return }

        let stored: String?
        do {
            stored = try Keychain.token(for: saved.id)
        } catch {
            // Keep the connection and say why. `.offline` rather than
            // `.unpaired` matters: the latter is what puts PairingView on
            // screen, and asking for a new code is the one recovery that
            // costs a walk to the computer.
            connection = saved
            restorePending = true
            status = .offline(
                (error as? KeychainError)?.isLocked == true
                    ? "Unlock this phone to reach your computer."
                    : error.localizedDescription
            )
            return
        }
        guard let stored else { return } // no token: genuinely not paired

        connection = saved
        token = stored
        // `orderedHosts` puts the stored host first, so the address that
        // worked last time is the one dialed first this time.
        rotation = CandidateRotation(hosts: saved.orderedHosts)
        client = CompanionClient(connection: saved, token: stored)
        status = .connecting
    }

    /// Redeem a one-time pairing credential. On success the device token goes
    /// to the keychain and the connection to defaults — deliberately apart,
    /// so the thing that gets backed up is never the credential.
    func pair(with connection: Connection, credential: String, deviceName: String) async throws {
        let paired = try await CompanionClient.pair(
            connection: connection,
            credential: credential,
            deviceName: deviceName
        )
        // prefer the name the computer calls itself over the Bonjour label
        var stored = connection
        if !paired.serverName.isEmpty { stored.name = paired.serverName }
        // The computer knows every address it answers on, and what it says at
        // redeem time beats whatever the invite carried. Then the host that
        // just redeemed the code leads: it demonstrably works from here.
        if let hosts = paired.hosts, !hosts.isEmpty { stored.hosts = hosts }
        stored.promote(stored.host)

        try Keychain.save(paired.token, for: stored.id)
        UserDefaults.standard.set(try? JSONEncoder().encode(stored), forKey: Self.connectionKey)

        self.connection = stored
        self.token = paired.token
        self.rotation = CandidateRotation(hosts: stored.orderedHosts)
        self.client = CompanionClient(connection: stored, token: paired.token)
        self.state = CompanionState()
        // A fresh pairing settles any restore that was still waiting on the
        // keychain — the token is in hand, so there is nothing left to retry.
        restorePending = false
        connect()
    }

    func receivePairingURL(_ url: URL) {
        guard status == .unpaired else {
            actionError = "This phone is already paired. Unpair it in Settings before connecting it to another computer."
            return
        }
        guard let invite = PairingInvite.parse(url) else {
            actionError = "That pairing invitation is not valid. Start pairing again on your computer."
            return
        }
        pairingInvite = invite
    }

    func consumePairingInvite() {
        pairingInvite = nil
    }

    func signOut() {
        streamTask?.cancel()
        streamTask = nil
        restorePending = false
        if let id = connection?.id { Keychain.remove(id) }
        UserDefaults.standard.removeObject(forKey: Self.connectionKey)
        connection = nil
        client = nil
        token = nil
        rotation = CandidateRotation(hosts: [])
        state = CompanionState()
        NotificationCoordinator.shared.setBadge(0)
        status = .unpaired
    }

    // MARK: - Lifecycle

    /// Called when the app comes to the front, and once at launch.
    func connect() {
        // A restore that found the keychain locked left `client` nil on
        // purpose. Coming to the front is the moment worth retrying on: the
        // app is on screen, so the phone is in someone's hand and unlocked.
        if client == nil, restorePending { restore() }
        guard client != nil, streamTask == nil else { return }
        reconnectDelay = 0
        streamGeneration += 1
        let generation = streamGeneration
        streamTask = Task { [weak self] in
            guard let self else { return }
            await self.run()
            guard self.streamGeneration == generation else { return }
            self.streamTask = nil
        }
    }

    /// Pull-to-refresh: reopen the stream, and hold the control open until
    /// the connection has actually settled one way or the other.
    ///
    /// `connect()` returns the moment the task is spawned, so a `refreshable`
    /// that only calls it snaps the spinner shut before a single byte has
    /// arrived — the gesture reads as "nothing happened", on precisely the
    /// occasion it exists for. Waiting for `status` to leave `.connecting`
    /// makes the spinner mean what it appears to mean; the deadline is there
    /// so a network that never answers still gives the control back.
    func refresh() async {
        restartStream()
        connect()
        let deadline = Date().addingTimeInterval(10)
        while status == .connecting, !Task.isCancelled, Date() < deadline {
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
    }

    /// Ask the harness to include this bot's computer in the stream, for as
    /// long as something is showing it.
    ///
    /// This costs a reconnect, which is the right trade: the alternative is
    /// a base64 desktop capture arriving every few seconds for the whole
    /// session, including on cellular, whether or not anyone is looking.
    /// The reconnect resumes from the cursor, so nothing is missed.
    func watchScreen(of botId: String) {
        screenWatchers += 1
        if screenWatchers == 1 { restartStream() }
    }

    func stopWatchingScreen(of botId: String) {
        screenWatchers = max(0, screenWatchers - 1)
        if screenWatchers == 0 {
            state.clearScreen(botId)
            restartStream()
        }
    }

    /// Reopen the stream so its query string matches what we now want. The
    /// cursor survives, so this is a gap, not a reset.
    private func restartStream() {
        guard streamTask != nil else { return }
        streamTask?.cancel()
        streamTask = nil
        connect()
    }

    /// Called when the app leaves the screen. iOS will kill the connection
    /// anyway; dropping it deliberately means the cursor is written down at
    /// a known point instead of wherever the socket happened to die.
    func disconnect() {
        streamTask?.cancel()
        streamTask = nil
    }

    private func run() async {
        while !Task.isCancelled {
            guard let client else { return }
            status = .connecting
            log.info("opening stream, cursor=\(self.state.cursor ?? "none", privacy: .public)")
            do {
                // The query is fixed when the connection opens, so changing
                // it means a new connection — `restartStream()` cancels this
                // task and starts another. Cancellation is the only exit;
                // breaking out here instead would fall through to the "the
                // harness went away" path and flash a lost-connection banner
                // on what is actually a deliberate reconnect.
                for try await frame in try client.events(since: state.cursor, screens: screenWatchers > 0) {
                    if Task.isCancelled { return }
                    reconnectDelay = 0

                    if case let .hello(cursor, resumed) = frame.frame {
                        log.info("stream live, resumed=\(resumed, privacy: .public)")
                        // false means the server could not replay the gap —
                        // the one case that costs a full hydrate. Commit the
                        // hello cursor only after that hydrate succeeds: if
                        // the request dies halfway through replay/hydration,
                        // reconnecting must still ask for the missing gap.
                        if !resumed {
                            try await hydrate()
                            state.resetCursor(cursor)
                        }
                        status = .live
                        // this candidate carried a live stream — dial it
                        // first from now on, including next launch
                        promoteWorkingHost()
                        continue
                    }
                    state.apply(frame)
                    if case let .notify(notification) = frame.frame {
                        NotificationCoordinator.shared.deliver(notification, sequence: frame.seq)
                    }
                    NotificationCoordinator.shared.setBadge(state.unreadCount)
                    state.advance(to: frame.seq)
                }
                // the stream ended without an error — the harness went away
                log.notice("stream ended without an error")
                status = .offline("Lost the connection.")
            } catch let error as APIError where error.isUnauthorized {
                log.error("stream refused: unauthorized")
                status = .unauthorized
                return
            } catch {
                // backgrounding cancels the stream on purpose; that is not a
                // failure to report, and it must not be retried
                if Task.isCancelled || error is CancellationError {
                    log.info("stream closed by us")
                    return
                }
                log.error("stream failed: \(error.localizedDescription, privacy: .public)")
                status = .offline(failureMessage(for: error))
            }

            if Task.isCancelled { return }
            // 1s, 2s, 4s… to 15s. A phone that woke on a network which is
            // not the laptop's should not hammer it.
            reconnectDelay = reconnectDelay == 0 ? 1 : min(reconnectDelay * 2, 15)
            try? await Task.sleep(nanoseconds: reconnectDelay * 1_000_000_000)
        }
    }

    private func hydrate() async throws {
        guard let client else { return }
        let fleet = try await client.fleet(messages: 50)
        log.info("hydrated \(fleet.bots.count, privacy: .public) bots, \(fleet.groups.count, privacy: .public) rooms")
        state.hydrate(fleet)
        NotificationCoordinator.shared.setBadge(state.unreadCount)
    }

    // MARK: - Which address to dial

    /// Turn a stream failure into advice a person can act on — and, when the
    /// failure is about the address rather than the pairing, move the dial to
    /// the next stored host so the retry that follows tries somewhere new.
    /// A 401 never reaches here: the unauthorized path returns above, which
    /// is what keeps a token problem from masquerading as an address walk.
    private func failureMessage(for error: Error) -> String {
        guard let urlError = error as? URLError, let connection else {
            return error.localizedDescription
        }
        let failed = rotation.current.isEmpty ? connection.host : rotation.current
        var next: String?
        if ConnectionAdvice.shouldTryAnotherHost(urlError.code), rotation.count > 1 {
            let candidate = rotation.advance()
            if let token {
                client = CompanionClient(connection: connection.dialing(candidate), token: token)
            }
            next = candidate
            log.info("advancing to candidate host \(candidate, privacy: .public)")
        }
        return ConnectionAdvice.message(for: urlError.code, host: failed, port: connection.port, tryingNext: next)
    }

    /// The candidate that just carried a live stream dials first from now on.
    /// Persisted, so the next launch starts from the address that works
    /// rather than re-walking the list from a stale front-runner.
    private func promoteWorkingHost() {
        let winner = rotation.current
        guard !winner.isEmpty, var updated = connection,
              updated.host != Connection.urlHost(winner) else { return }
        updated.promote(winner)
        connection = updated
        UserDefaults.standard.set(try? JSONEncoder().encode(updated), forKey: Self.connectionKey)
    }

    /// Replace the stored address by hand, keeping the pairing and its token.
    /// False when the text does not parse as a host or host:port.
    @discardableResult
    func updateAddress(_ text: String) -> Bool {
        guard var updated = connection, let parsed = Connection.parse(text) else { return false }
        updated.port = parsed.port
        updated.promote(parsed.host)
        connection = updated
        UserDefaults.standard.set(try? JSONEncoder().encode(updated), forKey: Self.connectionKey)
        rotation = CandidateRotation(hosts: updated.orderedHosts)
        if let token { client = CompanionClient(connection: updated, token: token) }
        // Dial the new address now rather than on the next backoff tick —
        // someone who just typed an address is watching the banner.
        restartStream()
        connect()
        return true
    }

    // MARK: - Actions
    //
    // Each of these does the thing and lets the event stream deliver the
    // result. Nothing here writes to `state` optimistically: the harness is
    // the source of truth, and a phone that draws its own version of events
    // is a phone that disagrees with the laptop.

    func send(_ text: String, to chat: Chat) async {
        await perform {
            switch chat {
            case let .bot(bot): try await $0.send(text: text, toBot: bot.id)
            case let .room(room): try await $0.send(text: text, toRoom: room.id)
            }
        }
    }

    func answer(threadId: String, card: OptionCard, choice: String) async {
        guard let requestId = card.requestId else { return }
        await perform {
            // Permission cards answer allow/deny; a question answers with
            // the chosen text. The harness tells them apart by `behavior`.
            if card.isPermission {
                try await $0.respond(
                    threadId: threadId,
                    requestId: requestId,
                    behavior: choice.lowercased() == "allow" ? "allow" : "deny"
                )
            } else {
                try await $0.respond(threadId: threadId, requestId: requestId, behavior: "answer", message: choice)
            }
        }
    }

    /// "Always allow" — the grant key comes from the card, never from
    /// anything derived here, so the phone and the harness cannot disagree
    /// about what was just permitted.
    func alwaysAllow(bot: Bot, card: OptionCard) async {
        guard let key = card.allowKey else { return }
        await perform { try await $0.alwaysAllow(botId: bot.id, key: key) }
    }

    /// Make a new bot. The harness chooses its name, colour and greeting, so
    /// one made here is indistinguishable from one made on the desktop.
    ///
    /// Creating a bot does not broadcast — the desktop adds it optimistically
    /// too — so the new bot is folded in here rather than waited for. Return
    /// it so the caller can open it, which is the only reason anyone taps the
    /// button.
    @discardableResult
    func createBot() async -> Bot? {
        guard let client else { return nil }
        do {
            let bot = try await client.createBot()
            state.apply(.bot(bot))
            return bot
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    func interrupt(bot: Bot) async {
        await perform { try await $0.interrupt(botId: bot.id) }
    }

    /// Ask for one fresh cloud viewer URL. Unlike ordinary actions this
    /// returns the value to a browser sheet and never writes it to app state.
    func cloudDesktop(for bot: Bot) async throws -> URL {
        guard let client else { throw APIError.transport("This computer is offline.") }
        do {
            return try await client.cloudDesktop(botId: bot.id).url
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            throw error
        }
    }

    func markRead(_ chat: Chat) async {
        await perform(quietly: true) {
            switch chat {
            case let .bot(bot): try await $0.markRead(botId: bot.id)
            case let .room(room): try await $0.markRead(roomId: room.id)
            }
        }
    }

    func loadOlder(threadId: String) async {
        guard let client, let oldest = state.transcript(forThread: threadId).first else { return }
        do {
            let page = try await client.messages(threadId: threadId, before: oldest.id, limit: 50)
            state.prepend(page, toThread: threadId)
        } catch {
            actionError = error.localizedDescription
        }
    }

    func image(threadId: String, messageId: String) async -> Data? {
        try? await client?.image(threadId: threadId, messageId: messageId)
    }

    func search(_ query: String) async -> [SearchHit] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2, let client else { return [] }
        do { return try await client.search(trimmed) }
        catch {
            actionError = error.localizedDescription
            return []
        }
    }

    /// Resolve a SQLite search hit into the live task/branch, load a page
    /// around it, and hand navigation the current chat record.
    func open(_ hit: SearchHit) async -> Chat? {
        guard let client else { return nil }
        do {
            if let botId = hit.botId, var bot = state.bot(botId) {
                if bot.threadId != hit.threadId {
                    bot = try await client.switchTask(botId: bot.id, threadId: hit.threadId)
                    state.apply(.bot(bot))
                }
                if !hit.onActivePath {
                    let leaf = try await client.setActiveBranch(botId: bot.id, messageId: hit.messageId)
                    state.apply(.thread(threadId: hit.threadId, activeLeafId: leaf))
                }
                let page = try await client.messages(threadId: hit.threadId, around: hit.messageId)
                state.merge(page, intoThread: hit.threadId)
                focusedMessageId = hit.messageId
                return state.bot(bot.id).map(Chat.bot)
            }
            if let groupId = hit.groupId,
               let room = state.rooms.first(where: { $0.id == groupId }) {
                let page = try await client.messages(threadId: hit.threadId, around: hit.messageId)
                state.merge(page, intoThread: hit.threadId)
                focusedMessageId = hit.messageId
                return .room(room)
            }
        } catch { actionError = error.localizedDescription }
        return nil
    }

    func consumeFocus(_ messageId: String) {
        if focusedMessageId == messageId { focusedMessageId = nil }
    }

    func createTask(for bot: Bot, title: String?) async {
        guard let client else { return }
        do { state.apply(.bot(try await client.createTask(botId: bot.id, title: title))) }
        catch { actionError = error.localizedDescription }
    }

    func switchTask(_ task: BotTask, for bot: Bot) async {
        guard let client, task.threadId != bot.threadId else { return }
        do { state.apply(.bot(try await client.switchTask(botId: bot.id, threadId: task.threadId))) }
        catch { actionError = error.localizedDescription }
    }

    func renameTask(_ task: BotTask, for bot: Bot, title: String) async {
        guard let client else { return }
        do {
            try await client.renameTask(botId: bot.id, threadId: task.threadId, title: title)
            await refresh()
        } catch { actionError = error.localizedDescription }
    }

    func deleteTask(_ task: BotTask, for bot: Bot) async {
        guard let client else { return }
        do { state.apply(.bot(try await client.deleteTask(botId: bot.id, threadId: task.threadId))) }
        catch { actionError = error.localizedDescription }
    }

    func react(to message: Message, in threadId: String, emoji: String) async {
        guard let client else { return }
        do {
            let patched = try await client.toggleReaction(threadId: threadId, messageId: message.id, emoji: emoji)
            state.apply(.messagePatch(threadId: threadId, message: patched))
        } catch { actionError = error.localizedDescription }
    }

    func edit(_ message: Message, for bot: Bot, text: String) async {
        await perform { try await $0.edit(botId: bot.id, messageId: message.id, text: text) }
    }

    func switchVersion(to message: Message, for bot: Bot) async {
        guard let client else { return }
        do {
            let leaf = try await client.setActiveBranch(botId: bot.id, messageId: message.id)
            state.apply(.thread(threadId: bot.threadId, activeLeafId: leaf))
        } catch { actionError = error.localizedDescription }
    }

    func export(threadId: String, format: String) async -> URL? {
        guard let client else { return nil }
        do {
            let exported = try await client.export(threadId: threadId, format: format)
            let name = URL(fileURLWithPath: exported.filename).lastPathComponent
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            try exported.data.write(to: url, options: .atomic)
            return url
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    func refreshNotificationAuthorization() async {
        notificationAuthorization = await NotificationCoordinator.shared.authorizationStatus()
    }

    func enableNotifications() async {
        if notificationAuthorization == .denied {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                await UIApplication.shared.open(url)
            }
            return
        }
        _ = await NotificationCoordinator.shared.requestAuthorization()
        await refreshNotificationAuthorization()
        NotificationCoordinator.shared.setBadge(state.unreadCount)
    }

    var notificationStatusText: String {
        switch notificationAuthorization {
        case .authorized: return "On"
        case .provisional: return "Quietly on"
        case .ephemeral: return "Temporarily on"
        case .denied: return "Off in Settings"
        case .notDetermined: return "Not enabled"
        @unknown default: return "Unknown"
        }
    }

    private func perform(quietly: Bool = false, _ body: (CompanionClient) async throws -> Void) async {
        guard let client else { return }
        do {
            try await body(client)
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
        } catch {
            if !quietly { actionError = error.localizedDescription }
        }
    }
}

/// A chat is a bot or a room. They share a thread, which is what every
/// message, approval and page is keyed by.
enum Chat: Identifiable, Hashable {
    case bot(Bot)
    case room(Room)

    var id: String {
        switch self {
        case let .bot(bot): return bot.id
        case let .room(room): return room.id
        }
    }

    static func == (left: Chat, right: Chat) -> Bool {
        switch (left, right) {
        case let (.bot(a), .bot(b)): return a.id == b.id
        case let (.room(a), .room(b)): return a.id == b.id
        default: return false
        }
    }

    func hash(into hasher: inout Hasher) {
        switch self {
        case let .bot(bot):
            hasher.combine(0)
            hasher.combine(bot.id)
        case let .room(room):
            hasher.combine(1)
            hasher.combine(room.id)
        }
    }

    var threadId: String {
        switch self {
        case let .bot(bot): return bot.threadId
        case let .room(room): return room.threadId
        }
    }

    var name: String {
        switch self {
        case let .bot(bot): return bot.name
        case let .room(room): return room.name
        }
    }

    var subtitle: String {
        switch self {
        case let .bot(bot): return bot.title
        case let .room(room): return "\(room.memberIds.count) bots"
        }
    }

    var unread: Bool {
        switch self {
        case let .bot(bot): return bot.unread
        case let .room(room): return room.unread
        }
    }

    var busy: Bool {
        switch self {
        case let .bot(bot): return bot.busy ?? false
        case let .room(room): return room.busyBotId != nil
        }
    }

    var color: String {
        switch self {
        case let .bot(bot): return bot.color
        case .room: return "blue"
        }
    }
}

/// A chat plus the two things a roster row shows that the record itself does
/// not carry: the preview line, and when the thread last moved. Both come out
/// of the same message — the last one in the transcript.
struct ChatSummary: Identifiable, Hashable {
    let chat: Chat
    let preview: String
    let lastActivity: Double
    let pinned: Bool

    var id: String { chat.id }
}

extension CompanionState {
    /// Everything worth showing in the chat list: pinned first, then unread,
    /// then most recently active. Hidden bots stay hidden.
    ///
    /// The derived fields are computed once here rather than asked for as the
    /// list is sorted and filtered. Each one walks a thread's messages to
    /// reach the last of them, and a comparator is called O(n log n) times
    /// while the search predicate runs over every chat on every keystroke —
    /// so the same transcript was being traversed dozens of times per frame
    /// to produce an answer that had not changed. One pass, then sort the
    /// results.
    var chatSummaries: [ChatSummary] {
        let bots = self.bots.filter { $0.hidden != true }.map(Chat.bot)
        let rooms = self.rooms.map(Chat.room)
        return (bots + rooms)
            .map { chat in
                let last = visibleTranscript(forThread: chat.threadId).last
                return ChatSummary(
                    chat: chat,
                    preview: Self.preview(of: last),
                    lastActivity: last?.at ?? 0,
                    pinned: Self.pinned(chat)
                )
            }
            .sorted { left, right in
                if left.pinned != right.pinned { return left.pinned }
                if left.chat.unread != right.chat.unread { return left.chat.unread }
                return left.lastActivity > right.lastActivity
            }
    }

    private static func pinned(_ chat: Chat) -> Bool {
        if case let .bot(bot) = chat { return bot.pinned ?? false }
        return false
    }

    /// The one line a roster row shows under the name, from whichever kind of
    /// message landed last.
    private static func preview(of last: Message?) -> String {
        guard let last else { return "" }
        switch last.kind {
        case .text: return last.text ?? ""
        case .options: return last.card?.isPending == true ? "Waiting on you" : (last.card?.title ?? "")
        case .activity: return last.tool?.name ?? ""
        case .screen: return "Screenshot"
        case .unknown: return last.text ?? ""
        }
    }
}
