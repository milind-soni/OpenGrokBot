// App entry, and the one place that decides when the event stream lives.
//
// A phone is not a desktop: the stream is torn down the moment the app
// leaves the screen, because iOS is going to kill it anyway and doing it
// deliberately means the cursor is written down at a known point. Coming
// back asks the harness what was missed rather than asking for everything.
import SwiftUI
import CompanionCore

@main
struct CompanionApp: App {
    @StateObject private var session = Session()
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("app_global_ui_zoom_scale") private var uiZoomScale: Double = 1.0
    @State private var showZoomHUD: Bool = false
    @State private var zoomToastTimer: Timer? = nil

    private func zoomIn() {
        let current = (uiZoomScale * 10).rounded() / 10
        let next = min(1.60, current + 0.10)
        withAnimation(.spring(response: 0.20, dampingFraction: 0.85)) {
            uiZoomScale = (next * 100).rounded() / 100
        }
        triggerZoomToast()
        Haptics.selection()
    }

    private func zoomOut() {
        let current = (uiZoomScale * 10).rounded() / 10
        let next = max(0.70, current - 0.10)
        withAnimation(.spring(response: 0.20, dampingFraction: 0.85)) {
            uiZoomScale = (next * 100).rounded() / 100
        }
        triggerZoomToast()
        Haptics.selection()
    }

    private func resetZoom() {
        withAnimation(.spring(response: 0.20, dampingFraction: 0.85)) {
            uiZoomScale = 1.0
        }
        triggerZoomToast()
        Haptics.selection()
    }

    private func triggerZoomToast() {
        zoomToastTimer?.invalidate()
        withAnimation(.spring(response: 0.20, dampingFraction: 0.8)) {
            showZoomHUD = true
        }
        zoomToastTimer = Timer.scheduledTimer(withTimeInterval: 1.2, repeats: false) { _ in
            withAnimation(.easeInOut(duration: 0.3)) {
                showZoomHUD = false
            }
        }
    }

    var body: some Scene {
        WindowGroup {
            ZStack(alignment: .top) {
                GeometryReader { geo in
                    let scale = max(0.5, CGFloat(uiZoomScale))
                    RootView()
                        .environmentObject(session)
                        .frame(
                            width: geo.size.width / scale,
                            height: geo.size.height / scale
                        )
                        .scaleEffect(scale, anchor: .topLeading)
                }

                // Transient Zoom HUD Indicator
                if showZoomHUD {
                    HStack(spacing: 6) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(Color.accentColor)
                        Text("Zoom \(Int((uiZoomScale * 100).rounded()))%")
                            .font(.system(size: 12, weight: .bold, design: .monospaced))
                            .foregroundColor(.white)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color.black.opacity(0.80))
                    .background(.ultraThinMaterial)
                    .clipShape(Capsule())
                    .overlay(Capsule().strokeBorder(Color.white.opacity(0.15), lineWidth: 0.6))
                    .shadow(color: Color.black.opacity(0.35), radius: 8, y: 3)
                    .padding(.top, 14)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .zIndex(999)
                }
            }
            .background {
                Group {
                    Button("") { zoomIn() }
                        .keyboardShortcut("+", modifiers: .command)
                    Button("") { zoomIn() }
                        .keyboardShortcut("=", modifiers: .command)
                    Button("") { zoomOut() }
                        .keyboardShortcut("-", modifiers: .command)
                    Button("") { resetZoom() }
                        .keyboardShortcut("0", modifiers: .command)
                }
                .opacity(0)
                .allowsHitTesting(false)
            }
            .onAppear { session.connect() }
            .onOpenURL { session.receivePairingURL($0) }
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .active:
                    session.connect()
                    Task { await session.refreshNotificationAuthorization() }
                case .background: session.disconnect()
                case .inactive: break
                @unknown default: break
                }
            }
        }
        #if targetEnvironment(macCatalyst) || os(macOS)
        .commands {
            SidebarCommands()
            TextEditingCommands()
            CommandMenu("View") {
                Button("Zoom In") { zoomIn() }
                    .keyboardShortcut("+", modifiers: .command)
                Button("Zoom In (Keypad)") { zoomIn() }
                    .keyboardShortcut("=", modifiers: .command)
                Button("Zoom Out") { zoomOut() }
                    .keyboardShortcut("-", modifiers: .command)
                Divider()
                Button("Actual Size (100%)") { resetZoom() }
                    .keyboardShortcut("0", modifiers: .command)
            }
        }
        #endif
    }
}

struct RootView: View {
    @EnvironmentObject private var session: Session
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif

    var body: some View {
        Group {
            switch session.status {
            case .unpaired:
                PairingView()
            case .unauthorized:
                UnpairedView()
            default:
                #if os(iOS)
                if horizontalSizeClass == .regular {
                    SplitCompanionView()
                } else {
                    ChatListView()
                }
                #else
                SplitCompanionView()
                #endif
            }
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { session.actionError != nil },
                set: { if !$0 { session.actionError = nil } }
            ),
            presenting: session.actionError
        ) { _ in
            Button("OK", role: .cancel) { session.actionError = nil }
        } message: { message in
            Text(message)
        }
    }
}

/// Fluid multi-column tablet & desktop workspace
struct SplitCompanionView: View {
    @EnvironmentObject private var session: Session
    @State private var selectedChat: Chat? = nil
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            ChatListView(selectedChat: $selectedChat, isSidebar: true)
                .navigationTitle("OpenMausMobile")
        } detail: {
            if let chat = selectedChat {
                ChatView(chat: chat)
                    .id(chat.threadId)
            } else {
                ContentUnavailableView(
                    "Select a Conversation",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Choose a bot or room from the sidebar to view transcript and approvals.")
                )
            }
        }
        .navigationSplitViewStyle(.balanced)
        .onAppear {
            autoSelectFirstChat()
        }
        .onChange(of: session.state.pendingApprovals.count) { _, _ in
            if selectedChat == nil {
                autoSelectFirstChat()
            }
        }
    }

    private func autoSelectFirstChat() {
        guard selectedChat == nil else { return }
        if let pending = session.state.pendingApprovals.first {
            if let bot = session.state.bot(forThread: pending.threadId) {
                selectedChat = .bot(bot)
                return
            }
            if let room = session.state.room(forThread: pending.threadId) {
                selectedChat = .room(room)
                return
            }
        }
        if let firstSummary = session.state.chatSummaries.first {
            selectedChat = firstSummary.chat
        }
    }
}

/// The token stopped working. Almost always because someone revoked this
/// phone on the computer — which is exactly what that button is for, so the
/// honest thing is to say so and offer to pair again.
struct UnpairedView: View {
    @EnvironmentObject private var session: Session

    var body: some View {
        ContentUnavailableView {
            Label("This phone was unpaired", systemImage: "lock.slash")
        } description: {
            Text("It was removed from the computer's companion settings, or the pairing was reset.")
        } actions: {
            Button("Pair again") { session.signOut() }
                .buttonStyle(.borderedProminent)
        }
    }
}
