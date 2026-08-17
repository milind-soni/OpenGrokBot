// The roster.
//
// Styled after the desktop's messaging-app feel rather than a settings
// list: big mascot faces, the bot's role as a chip beside its name, a
// preview line, and no dividers. Anything waiting on you is pulled to the
// top, because that is the one thing a phone is better at than the laptop.
import SwiftUI
import CompanionCore

struct ChatListView: View {
    @EnvironmentObject private var session: Session
    @State private var query = ""
    /// Driven so that making a bot can open it. Value-based navigation alone
    /// cannot push without a tap, and a new bot appearing silently at the
    /// bottom of the roster is a poor answer to pressing +.
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            // A hand-built header rather than the navigation bar. Two
            // reasons: `.searchable` anchors its field to the *bottom* of the
            // screen on iOS 26, which is not where a roster's search belongs,
            // and an empty-titled nav bar reserves a surprising amount of
            // room above the first row. Drawing it here makes the top of the
            // list the top of the screen on every iOS.
            VStack(spacing: 0) {
                header
                StatusBanner()

                ScrollView {
                    LazyVStack(spacing: 0) {
                        if query.isEmpty {
                            ForEach(session.state.pendingApprovals, id: \.message.id) { pending in
                                if let chat = chat(forThread: pending.threadId) {
                                    NavigationLink(value: chat) {
                                        WaitingRow(chat: chat, card: pending.message.card)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }

                        ForEach(chats) { summary in
                            NavigationLink(value: summary.chat) {
                                ChatRow(
                                    chat: summary.chat,
                                    preview: summary.preview,
                                    at: summary.lastActivity
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                }
                .refreshable { await session.refresh() }
                .overlay {
                    if chats.isEmpty {
                        ContentUnavailableView(
                            query.isEmpty ? "No bots yet" : "Nothing matches",
                            systemImage: query.isEmpty ? "bubble.left.and.bubble.right" : "magnifyingglass",
                            description: Text(
                                query.isEmpty
                                    ? "Bots you create on your computer show up here."
                                    : "No chat matches \u{201C}\(query)\u{201D}."
                            )
                        )
                    }
                }
            }
            // top-aligned: the roster fills downward from the header
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Chat.self) { ChatView(chat: $0) }
        }
    }

    /// Who you are, and how to find a chat — both at the top, always.
    private var header: some View {
        HStack(spacing: 12) {
            NavigationLink { SettingsView() } label: {
                ProfileAvatar(name: session.connection?.name ?? "You")
            }
            .buttonStyle(.plain)

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.secondary)

                TextField("Search chats", text: $query)
                    .font(.system(size: 16))
                    .submitLabel(.search)
                    .autocorrectionDisabled()

                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(Color.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Capsule().fill(Color.secondary.opacity(0.16)))

            // Same place the desktop puts it, top-right of the roster.
            Button {
                Task {
                    if let bot = await session.createBot() { path.append(Chat.bot(bot)) }
                }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.primary)
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New bot")
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 10)
    }

    private var chats: [ChatSummary] {
        let all = session.state.chatSummaries
        guard !query.isEmpty else { return all }
        return all.filter {
            $0.chat.name.localizedCaseInsensitiveContains(query)
                || $0.chat.subtitle.localizedCaseInsensitiveContains(query)
                || $0.preview.localizedCaseInsensitiveContains(query)
        }
    }

    private func chat(forThread threadId: String) -> Chat? {
        if let bot = session.state.bot(forThread: threadId) { return .bot(bot) }
        if let room = session.state.room(forThread: threadId) { return .room(room) }
        return nil
    }
}

struct ChatRow: View {
    let chat: Chat
    let preview: String
    let at: Double

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            MausAvatar(color: chat.color, size: 52)

            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(chat.name)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                        .layoutPriority(1)

                    // the bot's job, the way the desktop shows it
                    if !chat.subtitle.isEmpty {
                        Text(chat.subtitle)
                            .font(.system(size: 13))
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Capsule().fill(Color.secondary.opacity(0.15)))
                    }

                    Spacer(minLength: 4)

                    Text(RelativeStamp.list(at))
                        .font(.system(size: 14))
                        .foregroundStyle(Color.secondary)
                        .fixedSize()
                }

                HStack(alignment: .top, spacing: 8) {
                    Text(preview.isEmpty ? " " : preview)
                        .font(.system(size: 15))
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)

                    Spacer(minLength: 0)

                    if chat.busy {
                        ProgressView().controlSize(.mini)
                    } else if chat.unread {
                        Circle()
                            .fill(MausPalette.color(chat.color))
                            .frame(width: 9, height: 9)
                            .padding(.top, 5)
                    }
                }
            }
        }
        .padding(.vertical, 14)
        .contentShape(Rectangle())
    }
}

/// A bot that stopped and needs a person. The whole reason for the app, so
/// it gets to sit above the roster and look unlike everything else.
struct WaitingRow: View {
    let chat: Chat
    let card: OptionCard?

    var body: some View {
        HStack(spacing: 12) {
            MausAvatar(color: chat.color, size: 38)

            VStack(alignment: .leading, spacing: 3) {
                Label("\(chat.name) is waiting on you", systemImage: "hand.raised.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.primary)
                Text(card?.subtitle ?? "")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }

            Spacer(minLength: 0)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.accentColor.opacity(0.14))
        )
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }
}

/// Connection state, shown only when it is not "fine".
struct StatusBanner: View {
    @EnvironmentObject private var session: Session

    var body: some View {
        Group {
            switch session.status {
            case .live, .unpaired:
                EmptyView()
            case .connecting:
                banner("Connecting…", systemImage: "arrow.triangle.2.circlepath", tint: .secondary)
            case let .offline(reason):
                banner(reason, systemImage: "wifi.slash", tint: .orange)
            case .unauthorized:
                banner("This phone was unpaired on the computer.", systemImage: "lock.slash", tint: .red)
            }
        }
        .animation(.default, value: session.status)
    }

    private func banner(_ text: String, systemImage: String, tint: Color) -> some View {
        Label(text, systemImage: systemImage)
            .font(.footnote)
            .foregroundStyle(tint)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.regularMaterial, in: Capsule())
            .padding(.top, 4)
    }
}

/// Timestamps the way a messaging app writes them.
enum RelativeStamp {
    /// Roster: time today, weekday this week, date beyond that.
    static func list(_ at: Double) -> String {
        guard at > 0 else { return "" }
        let date = Date(timeIntervalSince1970: at / 1000)
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if let week = calendar.date(byAdding: .day, value: -6, to: Date()), date > week {
            return date.formatted(.dateTime.weekday(.wide))
        }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }

    /// In a transcript: enough to place a gap in the conversation.
    static func separator(_ date: Date) -> String {
        let calendar = Calendar.current
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDateInToday(date) { return "Today \(time)" }
        if calendar.isDateInYesterday(date) { return "Yesterday \(time)" }
        return "\(date.formatted(.dateTime.day().month(.abbreviated))) \(time)"
    }
}
