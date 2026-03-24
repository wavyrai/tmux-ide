import SwiftUI

struct CanvasTileView: View {
    let item: CanvasItem
    let sessionName: String
    let baseURL: URL
    var isSelected: Bool = false

    @Environment(\.themeColors) private var themeColors
    @EnvironmentObject private var discovery: SessionDiscoveryService

    init(item: CanvasItem, sessionName: String = "", baseURL: URL = ConnectionTarget.localhost.baseURL, isSelected: Bool = false) {
        self.item = item
        self.sessionName = sessionName
        self.baseURL = baseURL
        self.isSelected = isSelected
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
                    .foregroundStyle(themeColors.primaryText)
                    .lineLimit(1)
                Spacer()
                if let badge = agentBadge {
                    AgentBadgeView(status: badge)
                }
                Text(tileSubtitle)
                    .font(.caption2)
                    .foregroundStyle(themeColors.tertiaryText)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(themeColors.surface1)

            // Content area
            tileContent
                .frame(minHeight: item.preferredHeight.map { CGFloat($0) } ?? 200)
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(borderColor, lineWidth: borderWidth)
        )
        .overlay {
            // Focus ring when selected
            if isSelected {
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(themeColors.accent, lineWidth: 2)
            }
        }
        .shadow(color: .black.opacity(0.15), radius: 6, y: 3)
        .contextMenu {
            Button("Close Tile") {
                // Future: coordinator.closeTile(item.id)
            }
            Button("Focus in Full Screen") {
                // Future: coordinator.fullScreenTile(item.id)
            }
            Divider()
            Button("Move Left") {
                // Future: coordinator.moveTile(item.id, direction: .left)
            }
            Button("Move Right") {
                // Future: coordinator.moveTile(item.id, direction: .right)
            }
        }
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
        case nil: return themeColors.divider
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
            TerminalTileView(
                paneId: paneId,
                baseURL: baseURL,
                sessionName: sessionName
            )
        case .browser(let url):
            WebViewTileView(initialURL: url)
        case .dashboard:
            ZStack {
                themeColors.surface0
                VStack {
                    Image(systemName: "chart.bar")
                        .font(.title)
                        .foregroundStyle(themeColors.accent.opacity(0.5))
                    Text("Command Center")
                        .font(.caption)
                        .foregroundStyle(themeColors.secondaryText)
                }
            }
        }
    }
}
