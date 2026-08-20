import SwiftUI
import CompanionCore

struct AgentInspectorSidebarView: View {
    let chat: Chat
    let onOpenComputer: () -> Void
    let onOpenTasks: () -> Void
    let onSteer: () -> Void
    let onClear: () -> Void
    
    @EnvironmentObject private var session: Session
    @Environment(\.colorScheme) private var colorScheme
    @State private var copiedDirectives = false
    
    init(
        chat: Chat,
        onOpenComputer: @escaping () -> Void,
        onOpenTasks: @escaping () -> Void,
        onSteer: @escaping () -> Void,
        onClear: @escaping () -> Void
    ) {
        self.chat = chat
        self.onOpenComputer = onOpenComputer
        self.onOpenTasks = onOpenTasks
        self.onSteer = onSteer
        self.onClear = onClear
    }
    
    private var currentChat: Chat {
        switch chat {
        case let .bot(bot): return session.state.bot(bot.id).map(Chat.bot) ?? chat
        case let .room(room):
            return session.state.rooms.first { $0.id == room.id }.map(Chat.room) ?? chat
        }
    }
    
    private var isBot: Bool {
        if case .bot = currentChat { return true }
        return false
    }

    private var isStreaming: Bool {
        session.state.streaming[chat.threadId] != nil
    }
    
    private var pendingApprovalsCount: Int {
        session.state.pendingApprovals.filter { $0.threadId == chat.threadId }.count
    }
    
    var body: some View {
        let isDark = colorScheme == .dark
        let accentColor = MausPalette.color(currentChat.color)
        
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 14) {
                // 1. Hero Dossier
                heroDossierCard(accentColor: accentColor, isDark: isDark)
                
                // 2. Telemetry & Stats Grid
                telemetryGrid(accentColor: accentColor, isDark: isDark)
                
                // 3. Quick Control Deck
                quickControlsCard(accentColor: accentColor, isDark: isDark)
                
                // 4. Session Directives & Runtime Details
                runtimeDetailsCard(accentColor: accentColor, isDark: isDark)
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .background(
            isDark ? Color(hex: "#090D16") : Color(hex: "#F8FAFC")
        )
        .navigationTitle("Agent Inspector")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
    
    // MARK: - 1. Hero Dossier
    @ViewBuilder
    private func heroDossierCard(accentColor: Color, isDark: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                ZStack {
                    Circle()
                        .stroke(
                            LinearGradient(
                                colors: [accentColor.opacity(0.9), accentColor.opacity(0.2)],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ),
                            lineWidth: 2
                        )
                        .frame(width: 62, height: 62)
                    
                    MausAvatar(color: currentChat.color, size: 54)
                }
                .shadow(color: accentColor.opacity(0.35), radius: 8, y: 2)
                
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(currentChat.name)
                            .font(.system(size: 18, weight: .bold))
                            .foregroundColor(isDark ? .white : Color(hex: "#0F172A"))
                            .lineLimit(1)
                        
                        if isBot {
                            Image(systemName: "checkmark.seal.fill")
                                .font(.system(size: 13))
                                .foregroundColor(Color(hex: "#38BDF8"))
                        }
                    }
                    
                    HStack(spacing: 5) {
                        Circle()
                            .fill(isStreaming ? Color(hex: "#38BDF8") : (currentChat.busy ? Color(hex: "#F59E0B") : Color(hex: "#10B981")))
                            .frame(width: 6, height: 6)
                        
                        Text(isStreaming ? "Streaming Tokens" : (currentChat.busy ? "Executing Steps" : "Ready / Idle"))
                            .font(.caption2.weight(.bold))
                            .foregroundColor(isStreaming ? Color(hex: "#38BDF8") : (currentChat.busy ? Color(hex: "#F59E0B") : Color(hex: "#10B981")))
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isDark ? Color.white.opacity(0.04) : Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(isDark ? Color.white.opacity(0.08) : Color.black.opacity(0.06), lineWidth: 0.8)
        )
    }
    
    // MARK: - 2. Telemetry Grid
    @ViewBuilder
    private func telemetryGrid(accentColor: Color, isDark: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("RUNTIME TELEMETRY")
                .font(.system(size: 10, weight: .heavy, design: .monospaced))
                .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                .padding(.horizontal, 2)
            
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                telemetryTile(
                    title: "Pending Approvals",
                    value: "\(pendingApprovalsCount)",
                    icon: "lock.shield",
                    tint: pendingApprovalsCount > 0 ? Color(hex: "#EF4444") : Color(hex: "#10B981"),
                    isDark: isDark
                )
                telemetryTile(
                    title: "Transcript Length",
                    value: "\(session.state.visibleTranscript(forThread: chat.threadId).count) msgs",
                    icon: "bubble.left.and.bubble.right",
                    tint: Color(hex: "#38BDF8"),
                    isDark: isDark
                )
                telemetryTile(
                    title: "Driver Protocol",
                    value: "Encrypted SSE",
                    icon: "network",
                    tint: Color(hex: "#A855F7"),
                    isDark: isDark
                )
                telemetryTile(
                    title: "Channel Mode",
                    value: isBot ? "Direct Agent" : "Group Room",
                    icon: isBot ? "person.crop.circle" : "person.3",
                    tint: accentColor,
                    isDark: isDark
                )
            }
        }
    }
    
    private func telemetryTile(title: String, value: String, icon: String, tint: Color, isDark: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(tint)
                Text(title)
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                    .lineLimit(1)
            }
            Text(value)
                .font(.system(size: 12.5, weight: .bold, design: .monospaced))
                .foregroundColor(isDark ? .white : Color(hex: "#0F172A"))
                .lineLimit(1)
        }
        .padding(9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isDark ? Color.white.opacity(0.04) : Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .stroke(isDark ? Color.white.opacity(0.07) : Color.black.opacity(0.05), lineWidth: 0.6)
        )
    }
    
    // MARK: - 3. Quick Controls
    @ViewBuilder
    private func quickControlsCard(accentColor: Color, isDark: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("QUICK AGENT ACTIONS")
                .font(.system(size: 10, weight: .heavy, design: .monospaced))
                .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                .padding(.horizontal, 2)
            
            VStack(spacing: 6) {
                actionButton(
                    title: "Live Computer Canvas",
                    subtitle: "Stream interactive GUI desktop",
                    icon: "desktopcomputer",
                    tint: Color(hex: "#38BDF8"),
                    isDark: isDark,
                    action: onOpenComputer
                )
                actionButton(
                    title: "Task Manager",
                    subtitle: "Inspect active background threads",
                    icon: "square.stack.fill",
                    tint: Color(hex: "#A855F7"),
                    isDark: isDark,
                    action: onOpenTasks
                )
                actionButton(
                    title: "Steer & Guide Bot",
                    subtitle: "Inject guidance into active reasoning",
                    icon: "steeringwheel",
                    tint: Color(hex: "#F97316"),
                    isDark: isDark,
                    action: onSteer
                )
                actionButton(
                    title: "Clear Transcript",
                    subtitle: "Reset local conversation buffer",
                    icon: "trash",
                    tint: Color(hex: "#EF4444"),
                    isDark: isDark,
                    action: onClear
                )
            }
        }
    }
    
    private func actionButton(title: String, subtitle: String, icon: String, tint: Color, isDark: Bool, action: @escaping () -> Void) -> some View {
        Button(action: {
            Haptics.selection()
            action()
        }) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(tint)
                    .frame(width: 28, height: 28)
                    .background(tint.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 7))
                
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.system(size: 12.5, weight: .bold))
                        .foregroundColor(isDark ? .white : Color(hex: "#0F172A"))
                    Text(subtitle)
                        .font(.system(size: 10))
                        .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                }
                
                Spacer()
                
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(isDark ? Color(hex: "#475569") : Color(hex: "#94A3B8"))
            }
            .padding(9)
            .background(isDark ? Color.white.opacity(0.04) : Color.white)
            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .stroke(isDark ? Color.white.opacity(0.07) : Color.black.opacity(0.05), lineWidth: 0.6)
            )
        }
        .buttonStyle(.plain)
    }
    
    // MARK: - 4. Runtime Details
    @ViewBuilder
    private func runtimeDetailsCard(accentColor: Color, isDark: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("THREAD IDENTIFIER")
                    .font(.system(size: 10, weight: .heavy, design: .monospaced))
                    .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                
                Spacer()
                
                Button {
                    PlatformBridge.copyToPasteboard(chat.threadId)
                    copiedDirectives = true
                    Haptics.selection()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        copiedDirectives = false
                    }
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: copiedDirectives ? "checkmark" : "doc.on.doc")
                        Text(copiedDirectives ? "Copied" : "Copy ID")
                    }
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(accentColor)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 2)
            
            Text(chat.threadId)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(isDark ? Color(hex: "#CBD5E1") : Color(hex: "#334155"))
                .padding(9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(isDark ? Color.white.opacity(0.04) : Color.white)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(isDark ? Color.white.opacity(0.06) : Color.black.opacity(0.05), lineWidth: 0.6)
                )
        }
    }
}
