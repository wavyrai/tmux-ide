import SwiftUI

/// A SwiftUI view that renders a live tmux pane mirror using Ghostty.
///
/// Connects to the command-center WebSocket mirror for the given pane and renders
/// the terminal output through a GhosttyTerminalSurface. User keyboard input is
/// intercepted and sent back over the WebSocket to the tmux pane.
struct TerminalTileView: View {
    let paneId: String
    let baseURL: URL
    let sessionName: String

    @StateObject private var controller = MirrorTerminalController()

    var body: some View {
        ZStack {
            // Terminal surface
            if let surface = controller.surface {
                GhosttyTerminalView(surface: surface)
            } else {
                // Surface not yet created
                Color.black
            }

            // Connection status overlay
            if !controller.isConnected {
                connectionOverlay
            }
        }
        .onAppear {
            controller.prepareSurface()
            controller.connect(baseURL: baseURL, session: sessionName, paneId: paneId)
        }
        .onDisappear {
            controller.tearDown()
        }
    }

    @ViewBuilder
    private var connectionOverlay: some View {
        ZStack {
            Color.black.opacity(0.7)

            VStack(spacing: 12) {
                if let error = controller.connectionError {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.title2)
                        .foregroundStyle(.yellow)
                    Text("Connection Lost")
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundStyle(.white)
                    Text(error)
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.6))
                        .multilineTextAlignment(.center)
                        .lineLimit(3)
                        .padding(.horizontal, 20)
                } else {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                    Text("Connecting to \(paneId)...")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.7))
                }
            }
        }
    }
}
