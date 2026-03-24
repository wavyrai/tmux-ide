import SwiftUI

/// A small status badge that shows agent state on terminal tiles.
/// - Green dot: idle
/// - Yellow dot with pulse: busy
/// - Red dot with pulse: error/waiting
struct AgentBadgeView: View {
    let status: AgentBadgeStatus

    @State private var isPulsing = false

    var body: some View {
        Circle()
            .fill(badgeColor)
            .frame(width: 8, height: 8)
            .overlay(
                Circle()
                    .stroke(badgeColor.opacity(0.5), lineWidth: 2)
                    .scaleEffect(isPulsing ? 2.0 : 1.0)
                    .opacity(isPulsing ? 0 : 1)
            )
            .onAppear { updatePulse() }
            .onChange(of: status) { updatePulse() }
    }

    private var badgeColor: Color {
        switch status {
        case .idle: return .green
        case .busy: return .yellow
        case .error: return .red
        }
    }

    private func updatePulse() {
        let shouldPulse = status == .busy || status == .error
        withAnimation(shouldPulse ? .easeInOut(duration: 1.0).repeatForever(autoreverses: false) : .default) {
            isPulsing = shouldPulse
        }
    }
}
