import SwiftUI
import CompanionCore

public struct InlineReplyBanner: View {
    public let message: Message
    public let botName: String
    public let accentColor: Color
    @Binding public var replyingTo: Message?
    
    @Environment(\.colorScheme) private var colorScheme
    
    public init(
        message: Message,
        botName: String = "Bot",
        accentColor: Color = .purple,
        replyingTo: Binding<Message?>
    ) {
        self.message = message
        self.botName = botName
        self.accentColor = accentColor
        self._replyingTo = replyingTo
    }
    
    public var body: some View {
        let isDark = colorScheme == .dark
        let isUser = message.role == .user
        
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(accentColor)
                .frame(width: 3, height: 24)
            
            VStack(alignment: .leading, spacing: 2) {
                Text(isUser ? "Replying to your message" : "Replying to \(botName)")
                    .font(.caption2.weight(.bold))
                    .foregroundColor(accentColor)
                
                Text(message.text ?? "Attachment")
                    .font(.caption2)
                    .foregroundColor(isDark ? Color(hex: "#E2E8F0") : Color(hex: "#1E293B"))
                    .lineLimit(1)
            }
            
            Spacer()
            
            Button {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    replyingTo = nil
                }
                Haptics.selection()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 15))
                    .foregroundColor(isDark ? Color(hex: "#64748B") : Color(hex: "#94A3B8"))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(isDark ? Color.black.opacity(0.4) : Color.white.opacity(0.95))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(isDark ? Color.white.opacity(0.1) : Color.black.opacity(0.06), lineWidth: 0.5)
        )
        .shadow(color: Color.black.opacity(0.06), radius: 4, y: 2)
        .padding(.horizontal, 14)
        .padding(.bottom, 2)
    }
}
