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
    @Binding var selectedChat: Chat?
    var isSidebar: Bool = false

    @State private var query = ""
    /// Driven so that making a bot can open it in single-column mode.
    @State private var path = NavigationPath()
    @State private var searchHits: [SearchHit] = []
    @State private var searching = false
    @FocusState private var searchFieldFocused: Bool
    @State private var showingSettings = false

    init(selectedChat: Binding<Chat?>? = nil, isSidebar: Bool = false) {
        self._selectedChat = selectedChat ?? .constant(nil)
        self.isSidebar = isSidebar
    }

    var body: some View {
        if isSidebar {
            sidebarContent
                .task(id: query) { await performSearch() }
                .sheet(isPresented: $showingSettings) {
                    NavigationStack { SettingsView() }
                }
        } else {
            NavigationStack(path: $path) {
                stackContent
                    .task(id: query) { await performSearch() }
            }
        }
    }

    // MARK: - Sidebar Layout (for iPadOS & Mac Catalyst NavigationSplitView)
    private var sidebarContent: some View {
        VStack(spacing: 0) {
            header(isSidebar: true)
            StatusBanner()

            ScrollView {
                LazyVStack(spacing: 0) {
                    if query.isEmpty {
                        ForEach(session.state.pendingApprovals, id: \.message.id) { pending in
                            if let chat = chat(forThread: pending.threadId) {
                                Button {
                                    selectedChat = chat
                                    Haptics.selection()
                                } label: {
                                    WaitingRow(
                                        chat: chat,
                                        card: pending.message.card,
                                        isSelected: selectedChat?.id == chat.id
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    if !query.isEmpty, !searchHits.isEmpty {
                        HStack {
                            Text("Messages")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Color.secondary)
                            Spacer()
                            if searching { ProgressView().controlSize(.small) }
                        }
                        .padding(.top, 10)
                        .padding(.bottom, 4)

                        ForEach(searchHits) { hit in
                            Button {
                                Task {
                                    if let chat = await session.open(hit) {
                                        selectedChat = chat
                                        Haptics.selection()
                                    }
                                }
                            } label: {
                                SearchHitRow(hit: hit)
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    ForEach(chats) { summary in
                        Button {
                            selectedChat = summary.chat
                            Haptics.selection()
                        } label: {
                            ChatRow(
                                chat: summary.chat,
                                preview: summary.preview,
                                at: summary.lastActivity,
                                isSelected: selectedChat?.id == summary.chat.id
                            )
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button("Select", systemImage: "bubble.left.and.bubble.right") {
                                selectedChat = summary.chat
                            }
                            Button("Copy Name", systemImage: "doc.on.doc") {
                                PlatformBridge.copyToPasteboard(summary.chat.name)
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .refreshable { await session.refresh() }
            .overlay {
                if chats.isEmpty && searchHits.isEmpty {
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
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background {
            Group {
                Button("") { searchFieldFocused = true }
                    .keyboardShortcut("k", modifiers: .command)
                Button("") { searchFieldFocused = true }
                    .keyboardShortcut("f", modifiers: .command)
                Button("") { showingSettings = true }
                    .keyboardShortcut(",", modifiers: .command)
                Button("") {
                    Task {
                        if let bot = await session.createBot() {
                            selectedChat = Chat.bot(bot)
                            Haptics.impact(.medium)
                        }
                    }
                }
                .keyboardShortcut("n", modifiers: .command)
                Button("") {
                    Task { await session.refresh() }
                }
                .keyboardShortcut("r", modifiers: .command)

                ForEach(0..<min(9, chats.count), id: \.self) { index in
                    Button("") {
                        if chats.indices.contains(index) {
                            selectedChat = chats[index].chat
                            Haptics.selection()
                        }
                    }
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
                }
            }
            .opacity(0)
            .allowsHitTesting(false)
        }
    }

    // MARK: - Stack Layout (for iPhone single-column NavigationStack)
    private var stackContent: some View {
        VStack(spacing: 0) {
            header(isSidebar: false)
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

                    if !query.isEmpty, !searchHits.isEmpty {
                        HStack {
                            Text("Messages")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Color.secondary)
                            Spacer()
                            if searching { ProgressView().controlSize(.small) }
                        }
                        .padding(.top, 10)
                        .padding(.bottom, 4)

                        ForEach(searchHits) { hit in
                            Button {
                                Task {
                                    if let chat = await session.open(hit) { path.append(chat) }
                                }
                            } label: {
                                SearchHitRow(hit: hit)
                            }
                            .buttonStyle(.plain)
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
                if chats.isEmpty && searchHits.isEmpty {
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
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: Chat.self) { ChatView(chat: $0) }
    }

    /// Search debounce and execution helper
    private func performSearch() async {
        let expected = query
        guard expected.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 else {
            searchHits = []
            searching = false
            return
        }
        searching = true
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled, query == expected else { return }
        searchHits = await session.search(expected)
        searching = false
    }

    /// Who you are, and how to find a chat — both at the top, always.
    private func header(isSidebar: Bool) -> some View {
        HStack(spacing: 12) {
            if isSidebar {
                Button {
                    showingSettings = true
                } label: {
                    ProfileAvatar(name: session.connection?.name ?? "You")
                }
                .buttonStyle(.plain)
            } else {
                NavigationLink { SettingsView() } label: {
                    ProfileAvatar(name: session.connection?.name ?? "You")
                }
                .buttonStyle(.plain)
            }

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.secondary)

                TextField("Search chats", text: $query)
                    .font(.system(size: 16))
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    .focused($searchFieldFocused)

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
                    if let bot = await session.createBot() {
                        if isSidebar {
                            selectedChat = Chat.bot(bot)
                        } else {
                            path.append(Chat.bot(bot))
                        }
                        Haptics.impact(.medium)
                    }
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

struct SearchHitRow: View {
    let hit: SearchHit

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: hit.role == .user ? "person.fill" : "bubble.left.fill")
                .foregroundStyle(Color.secondary)
                .frame(width: 26, height: 26)
                .background(Circle().fill(Color.secondary.opacity(0.13)))

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(hit.name).font(.system(size: 15, weight: .semibold))
                    if let task = hit.task, !task.isEmpty {
                        Text(task).font(.system(size: 12)).foregroundStyle(Color.secondary)
                    }
                    Spacer()
                    Text(RelativeStamp.list(hit.at))
                        .font(.system(size: 12))
                        .foregroundStyle(Color.secondary)
                }
                Text(hit.snippet)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

struct ChatRow: View {
    let chat: Chat
    let preview: String
    let at: Double
    var isSelected: Bool = false

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
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(isSelected ? Color.accentColor.opacity(0.15) : Color.clear)
        )
        .contentShape(Rectangle())
    }
}

/// A bot that stopped and needs a person. The whole reason for the app, so
/// it gets to sit above the roster and look unlike everything else.
struct WaitingRow: View {
    let chat: Chat
    let card: OptionCard?
    var isSelected: Bool = false

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
                .fill(isSelected ? Color.accentColor.opacity(0.25) : Color.accentColor.opacity(0.14))
        )
        .overlay {
            if isSelected {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(Color.accentColor, lineWidth: 1.5)
            }
        }
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
