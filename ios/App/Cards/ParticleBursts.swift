import SwiftUI

// MARK: - Confetti Particle
public struct ConfettiParticle: Identifiable {
    public let id = UUID()
    public var x: CGFloat
    public var y: CGFloat
    public var size: CGFloat
    public var color: Color
    public var vx: CGFloat
    public var vy: CGFloat
    public var rotation: Double
    public var vRotation: Double
    public var opacity: Double
    public var isRibbon: Bool
}

public struct ConfettiBurstView: View {
    @Binding public var isTriggered: Bool
    @State private var particles: [ConfettiParticle] = []
    @State private var timer = Timer.publish(every: 1.0 / 60.0, on: .main, in: .common).autoconnect()
    
    private let colors: [Color] = [
        Color(hex: "#FFD700"), // Radiant Gold
        Color(hex: "#FFA500"), // Amber Gold
        Color(hex: "#8B5CF6"), // Purple
        Color(hex: "#2563EB"), // Electric Blue
        Color(hex: "#38BDF8"), // Sky Cyan
        Color(hex: "#10B981"), // Emerald Green
        Color.white
    ]
    
    public init(isTriggered: Binding<Bool>) {
        self._isTriggered = isTriggered
    }
    
    public var body: some View {
        GeometryReader { geo in
            ZStack {
                ForEach(particles) { p in
                    Group {
                        if p.isRibbon {
                            RoundedRectangle(cornerRadius: 2)
                                .fill(p.color)
                                .frame(width: p.size * 0.4, height: p.size * 1.8)
                        } else {
                            Circle()
                                .fill(p.color)
                                .frame(width: p.size, height: p.size)
                        }
                    }
                    .rotationEffect(.degrees(p.rotation))
                    .opacity(p.opacity)
                    .position(x: p.x, y: p.y)
                }
            }
            .allowsHitTesting(false)
            .onChange(of: isTriggered) { _, triggered in
                if triggered {
                    spawnParticles(in: geo.size)
                }
            }
            .onReceive(timer) { _ in
                updatePhysics(in: geo.size)
            }
        }
    }
    
    private func spawnParticles(in size: CGSize) {
        var newParticles: [ConfettiParticle] = []
        let centerX = size.width / 2
        let startY = size.height * 0.45
        
        for _ in 0..<90 {
            let angle = Double.random(in: -Double.pi * 0.95 ... -Double.pi * 0.05)
            let speed = CGFloat.random(in: 10...26)
            let color = colors.randomElement() ?? .yellow
            
            newParticles.append(ConfettiParticle(
                x: centerX + CGFloat.random(in: -20...20),
                y: startY + CGFloat.random(in: -20...20),
                size: CGFloat.random(in: 7...14),
                color: color,
                vx: CGFloat(cos(angle)) * speed,
                vy: CGFloat(sin(angle)) * speed,
                rotation: Double.random(in: 0...360),
                vRotation: Double.random(in: -12...12),
                opacity: 1.0,
                isRibbon: Bool.random()
            ))
        }
        
        particles = newParticles
    }
    
    private func updatePhysics(in size: CGSize) {
        guard !particles.isEmpty else { return }
        
        for i in particles.indices {
            particles[i].x += particles[i].vx
            particles[i].y += particles[i].vy
            particles[i].vy += 0.50 // Gravity
            particles[i].vx *= 0.985 // Air drag
            particles[i].rotation += particles[i].vRotation
            
            if particles[i].y > size.height * 0.6 {
                particles[i].opacity -= 0.025
            }
        }
        
        particles.removeAll { $0.opacity <= 0.02 || $0.y > size.height + 60 }
        
        if particles.isEmpty && isTriggered {
            isTriggered = false
        }
    }
}

// MARK: - Heart Burst Particle
public struct HeartParticle: Identifiable {
    public let id = UUID()
    public var x: CGFloat
    public var y: CGFloat
    public var size: CGFloat
    public var vx: CGFloat
    public var vy: CGFloat
    public var scale: CGFloat
    public var opacity: Double
}

public struct HeartBurstParticleView: View {
    @Binding public var isTriggered: Bool
    @State private var particles: [HeartParticle] = []
    @State private var timer = Timer.publish(every: 1.0 / 60.0, on: .main, in: .common).autoconnect()
    
    public init(isTriggered: Binding<Bool>) {
        self._isTriggered = isTriggered
    }
    
    public var body: some View {
        GeometryReader { geo in
            ZStack {
                ForEach(particles) { p in
                    Image(systemName: "heart.fill")
                        .foregroundColor(Color(hex: "#EC4899"))
                        .font(.system(size: p.size))
                        .scaleEffect(p.scale)
                        .opacity(p.opacity)
                        .position(x: p.x, y: p.y)
                }
            }
            .allowsHitTesting(false)
            .onChange(of: isTriggered) { _, triggered in
                if triggered {
                    spawnHearts(in: geo.size)
                }
            }
            .onReceive(timer) { _ in
                updatePhysics(in: geo.size)
            }
        }
    }
    
    private func spawnHearts(in size: CGSize) {
        var newHearts: [HeartParticle] = []
        let centerX = size.width / 2
        let startY = size.height * 0.5
        
        for _ in 0..<20 {
            let angle = Double.random(in: -Double.pi * 0.9 ... -Double.pi * 0.1)
            let speed = CGFloat.random(in: 6...16)
            
            newHearts.append(HeartParticle(
                x: centerX + CGFloat.random(in: -15...15),
                y: startY + CGFloat.random(in: -15...15),
                size: CGFloat.random(in: 14...22),
                vx: CGFloat(cos(angle)) * speed,
                vy: CGFloat(sin(angle)) * speed,
                scale: 1.0,
                opacity: 1.0
            ))
        }
        
        particles = newHearts
    }
    
    private func updatePhysics(in size: CGSize) {
        guard !particles.isEmpty else { return }
        
        for i in particles.indices {
            particles[i].x += particles[i].vx
            particles[i].y += particles[i].vy
            particles[i].vy += 0.25
            particles[i].vx *= 0.96
            particles[i].scale = max(0.2, particles[i].scale - 0.015)
            particles[i].opacity -= 0.025
        }
        
        particles.removeAll { $0.opacity <= 0.02 }
        
        if particles.isEmpty && isTriggered {
            isTriggered = false
        }
    }
}
