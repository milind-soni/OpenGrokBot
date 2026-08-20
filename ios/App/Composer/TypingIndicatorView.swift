import SwiftUI

public struct TypingIndicatorView: View {
    public let tintColor: Color
    @State private var dotScales: [CGFloat] = [0.35, 0.35, 0.35]
    
    public init(tintColor: Color = .purple) {
        self.tintColor = tintColor
    }
    
    public var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3) { index in
                Circle()
                    .fill(tintColor.opacity(0.85))
                    .frame(width: 6.5, height: 6.5)
                    .scaleEffect(dotScales[index])
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.secondary.opacity(0.12))
        .clipShape(Capsule())
        .onAppear {
            animateDots()
        }
    }
    
    private func animateDots() {
        for i in 0..<3 {
            withAnimation(
                .easeInOut(duration: 0.5)
                .repeatForever(autoreverses: true)
                .delay(Double(i) * 0.16)
            ) {
                dotScales[i] = 1.0
            }
        }
    }
}
