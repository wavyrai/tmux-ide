import SwiftUI

struct CanvasTileView: View {
    let item: CanvasItem
    let sessionName: String
    let baseURL: URL

    @EnvironmentObject private var discovery: SessionDiscoveryService

    init(item: CanvasItem, sessionName: String = "", baseURL: URL = ConnectionTarget.localhost.baseURL) {
        self.item = item
        self.sessionName = sessionName
        self.baseURL = baseURL
    }

    var body: some View {
        VStack(spacing: 0) {
            // Title bar
            HStack {
                Circle()
                    .fill(tileColor)
                    .frame(width: 8, height: 8)
                Text(tileTitle)
                    .font(.caption)
                    .fontWeight(.medium)
                    .lineLimit(1)
                Spacer()
                if let badge = agentBadge {
                    AgentBadgeView(status: badge)
                }
                Text(tileSubtitle)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color(nsColor: .controlBackgroundColor))

            // Content area
            tileContent
                .frame(minHeight: item.preferredHeight.map { CGFloat($0) } ?? 200)
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(borderColor, lineWidth: borderWidth)
        )
        .shadow(color: .black.opacity(0.1), radius: 4, y: 2)
    }

    private var agentBadge: AgentBadgeStatus? {
        guard let title = item.paneTitle else { return nil }
        return discovery.badgeStatus(session: sessionName, paneTitle: title)
    }

    private var borderColor: Color {
        switch agentBadge {
        case .idle: return .green
        case .busy: return .yellow
        case .error: return .red
        case nil: return Color(nsColor: .separatorColor)
        }
    }

    private var borderWidth: CGFloat {
        agentBadge != nil ? 2 : 1
    }

    private var tileTitle: String {
        if let title = item.paneTitle {
            return title
        }
        switch item.ref {
        case .terminal(let paneId):
            return "Terminal \(paneId)"
        case .browser(let url):
            return url ?? "Browser"
        case .dashboard:
            return "Dashboard"
        }
    }

    private var tileSubtitle: String {
        switch item.ref {
        case .terminal: return "pane"
        case .browser: return "web"
        case .dashboard: return "overview"
        }
    }

    private var tileColor: Color {
        switch item.ref {
        case .terminal: return .green
        case .browser: return .blue
        case .dashboard: return .purple
        }
    }

    @ViewBuilder
    private var tileContent: some View {
        switch item.ref {
        case .terminal(let paneId):
            // TerminalTileView wraps GhosttyTerminalView with WebSocket mirror.
            // Requires the full Xcode build with Ghostty C bridge to render;
            // falls back to a placeholder if the surface cannot be created.
            TerminalTileView(
                paneId: paneId,
                baseURL: baseURL,
                sessionName: sessionName
            )
        case .browser(let url):
            // Placeholder — Phase 4 will render WKWebView here
            ZStack {
                Color(nsColor: .textBackgroundColor)
                VStack {
                    Image(systemName: "globe")
                        .font(.title)
                        .foregroundStyle(.blue.opacity(0.5))
                    Text(url ?? "about:blank")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        case .dashboard:
            // Placeholder — Phase 4 will render command-center dashboard
            ZStack {
                Color(nsColor: .textBackgroundColor)
                VStack {
                    Image(systemName: "chart.bar")
                        .font(.title)
                        .foregroundStyle(.purple.opacity(0.5))
                    Text("Command Center")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}
