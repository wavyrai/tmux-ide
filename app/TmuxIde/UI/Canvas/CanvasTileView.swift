import SwiftUI

struct CanvasTileView: View {
    let item: CanvasItem
    let sessionName: String
    let baseURL: URL
    var isSelected: Bool = false

    @Environment(\.themeColors) private var themeColors
    @EnvironmentObject private var discovery: SessionDiscoveryService
    @State private var isHovered = false

    init(item: CanvasItem, sessionName: String = "", baseURL: URL = ConnectionTarget.localhost.baseURL, isSelected: Bool = false) {
        self.item = item
        self.sessionName = sessionName
        self.baseURL = baseURL
        self.isSelected = isSelected
    }

    var body: some View {
        VStack(spacing: 0) {
            titleBar
            Divider()
                .overlay(themeColors.surface2.opacity(0.5))
            tileContent
                .frame(minHeight: item.preferredHeight.map { CGFloat($0) } ?? 200)
        }
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(borderColor, lineWidth: borderWidth)
        )
        .overlay {
            if isSelected {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(themeColors.accent, lineWidth: 2)
            }
        }
        .shadow(color: .black.opacity(isHovered ? 0.25 : 0.15), radius: isHovered ? 10 : 6, y: isHovered ? 5 : 3)
        .scaleEffect(isHovered && !isSelected ? 1.005 : 1.0)
        .animation(.easeOut(duration: 0.15), value: isHovered)
        .onHover { hovering in
            isHovered = hovering
        }
        .contextMenu { tileContextMenu }
    }

    // MARK: - Title Bar

    private var titleBar: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(tileColor)
                .frame(width: 8, height: 8)
                .shadow(color: tileColor.opacity(0.4), radius: 3)

            Text(tileTitle)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(themeColors.primaryText)
                .lineLimit(1)

            Spacer(minLength: 4)

            if let badge = agentBadge {
                AgentBadgeView(status: badge)
                    .transition(.opacity.combined(with: .scale(scale: 0.8)))
            }

            Text(tileSubtitle)
                .font(.system(size: 10, weight: .regular))
                .foregroundStyle(themeColors.tertiaryText)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(
                    Capsule()
                        .fill(themeColors.surface2.opacity(0.5))
                )
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(themeColors.surface1)
    }

    // MARK: - Agent Badge

    private var agentBadge: AgentBadgeStatus? {
        guard let title = item.paneTitle else { return nil }
        return discovery.badgeStatus(session: sessionName, paneTitle: title)
    }

    // MARK: - Border

    private var borderColor: Color {
        switch agentBadge {
        case .idle: return .green.opacity(0.7)
        case .busy: return .yellow.opacity(0.7)
        case .error: return .red.opacity(0.7)
        case nil: return themeColors.surface2.opacity(0.6)
        }
    }

    private var borderWidth: CGFloat {
        agentBadge != nil ? 1.5 : 0.5
    }

    // MARK: - Labels

    private var tileTitle: String {
        if let title = item.paneTitle {
            return title
        }
        switch item.ref {
        case .terminal:
            return "Terminal"
        case .browser(let url):
            if let url, let host = URL(string: url)?.host {
                return host
            }
            return "Browser"
        case .dashboard:
            return "Dashboard"
        }
    }

    private var tileSubtitle: String {
        switch item.ref {
        case .terminal: return "shell"
        case .browser: return "web"
        case .dashboard: return "overview"
        }
    }

    private var tileColor: Color {
        switch item.ref {
        case .terminal: return .green
        case .browser: return .blue
        case .dashboard: return themeColors.accent
        }
    }

    // MARK: - Content

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
            dashboardPlaceholder
        }
    }

    private var dashboardPlaceholder: some View {
        ZStack {
            themeColors.surface0
            VStack(spacing: 8) {
                Image(systemName: "square.grid.2x2")
                    .font(.system(size: 28, weight: .light))
                    .foregroundStyle(themeColors.accent.opacity(0.4))
                Text("Command Center")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(themeColors.secondaryText)
            }
        }
    }

    // MARK: - Context Menu

    @ViewBuilder
    private var tileContextMenu: some View {
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
