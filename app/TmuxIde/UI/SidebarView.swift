import SwiftUI

struct SidebarView: View {
    @EnvironmentObject var coordinator: AppCoordinator
    @EnvironmentObject var discovery: SessionDiscoveryService
    @EnvironmentObject var connectionManager: ConnectionManager
    @Environment(\.themeColors) private var tc
    @State private var pendingReviewCount: Int = 0

    private var hasRemoteTargets: Bool {
        connectionManager.targets.contains { !$0.isLocal }
    }

    var body: some View {
        VStack(spacing: 0) {
            // SESSIONS header
            sessionsHeader

            // Session list
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if hasRemoteTargets {
                        ForEach(connectionManager.targets) { target in
                            let sessions = connectionManager.aggregatedSessions.filter {
                                $0.endpointID == target.id
                            }
                            if !sessions.isEmpty {
                                EndpointSection(
                                    target: target,
                                    sessions: sessions.map(\.overview),
                                    health: connectionManager.health[target.id],
                                    selectedSession: coordinator.selectedSession,
                                    onSelect: { coordinator.selectSession($0) }
                                )
                            }
                        }
                    } else {
                        ForEach(discovery.sessions) { session in
                            SessionRowView(
                                session: session,
                                isSelected: coordinator.selectedSession == session.name,
                                onSelect: { coordinator.selectSession(session.name) }
                            )
                        }
                    }
                }
                .padding(.vertical, 2)
            }

            // Pending reviews badge
            if pendingReviewCount > 0 {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.shield")
                        .font(.caption)
                        .foregroundStyle(.orange)
                    Text("\(pendingReviewCount) pending review\(pendingReviewCount == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(tc.primaryText)
                    Spacer()
                    Text("\(pendingReviewCount)")
                        .font(.caption2.weight(.bold).monospaced())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(.orange))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(tc.surface1.opacity(0.3))
            }

            // Bottom toolbar
            bottomToolbar
        }
        .background(tc.sidebarBackground)
        .task {
            await pollPendingReviews()
        }
    }

    private func pollPendingReviews() async {
        while !Task.isCancelled {
            if let session = coordinator.selectedSession {
                let client = CommandCenterClient(target: .localhost)
                let checkpoints = (try? await client.fetchCheckpoints(session: session)) ?? []
                let reviews = (try? await client.fetchReviews(session: session)) ?? []
                let pending = checkpoints.filter { $0.status == "pending" }.count
                    + reviews.filter { $0.status == "open" }.count
                await MainActor.run { pendingReviewCount = pending }
            }
            try? await Task.sleep(for: .seconds(15))
        }
    }

    // MARK: - Header

    @ViewBuilder
    private var sessionsHeader: some View {
        HStack(spacing: 4) {
            Text("SESSIONS")
                .font(.caption2.weight(.bold))
                .tracking(1)
                .foregroundStyle(tc.mutedText)

            Text("\(discovery.sessions.count)")
                .font(.caption2.weight(.semibold).monospaced())
                .foregroundStyle(tc.mutedText)

            Spacer()

            if discovery.isSSEConnected {
                Image(systemName: "antenna.radiowaves.left.and.right")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(tc.accent.opacity(0.7))
                    .help("Real-time updates via SSE")
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 6)
    }

    // MARK: - Bottom Toolbar

    @ViewBuilder
    private var bottomToolbar: some View {
        Divider()
            .background(tc.divider)

        HStack(spacing: 8) {
            Button {
                Task { await discovery.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.caption)
                    .foregroundStyle(tc.secondaryText)
                    .frame(width: 22, height: 22)
                    .background(tc.surface0.opacity(0.5), in: RoundedRectangle(cornerRadius: 5))
            }
            .buttonStyle(.plain)
            .help("Refresh sessions")

            Spacer()

            ConnectionIndicator(isConnected: discovery.isConnected, isSSE: discovery.isSSEConnected)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

// MARK: - Endpoint Section (for remote targets)

private struct EndpointSection: View {
    @Environment(\.themeColors) private var tc

    let target: ConnectionTarget
    let sessions: [SessionOverview]
    let health: ConnectionManager.EndpointHealth?
    let selectedSession: String?
    let onSelect: (String) -> Void

    @State private var isCollapsed = false

    var body: some View {
        // Endpoint header
        Button {
            withAnimation(.easeOut(duration: 0.15)) {
                isCollapsed.toggle()
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(tc.tertiaryText)
                    .frame(width: 10)

                Image(systemName: "network")
                    .font(.caption)
                    .foregroundStyle(tc.accent)

                Text(target.label)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(tc.primaryText)
                    .lineLimit(1)

                Spacer(minLength: 0)

                Circle()
                    .fill(healthColor)
                    .frame(width: 6, height: 6)

                Text("\(sessions.count)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(tc.tertiaryText)
            }
            .padding(.vertical, 5)
            .padding(.horizontal, 12)
        }
        .buttonStyle(.plain)

        if !isCollapsed {
            ForEach(sessions) { session in
                SessionRowView(
                    session: session,
                    isSelected: selectedSession == session.name,
                    onSelect: { onSelect(session.name) }
                )
                .padding(.leading, 8)
            }
        }
    }

    private var healthColor: Color {
        switch health {
        case .reachable: return .green
        case .unreachable: return .red
        case .tailscalePeerOffline: return .orange
        case .unknown, .none: return .gray
        @unknown default: return .gray
        }
    }
}

// MARK: - Session Row

struct SessionRowView: View {
    @Environment(\.themeColors) private var tc

    let session: SessionOverview
    let isSelected: Bool
    let onSelect: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 8) {
                // Status icon with pulse
                AgentStatusIcon(activeAgents: session.stats.activeAgents)

                // Session info
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(tc.primaryText)
                        .lineLimit(1)

                    if let mission = session.mission {
                        Text(mission.title)
                            .font(.caption)
                            .foregroundStyle(tc.tertiaryText)
                            .lineLimit(1)
                    }

                    // Stats bar
                    HStack(spacing: 10) {
                        if session.stats.totalTasks > 0 {
                            HStack(spacing: 3) {
                                Image(systemName: "checkmark.circle")
                                    .font(.caption2)
                                Text("\(session.stats.doneTasks)/\(session.stats.totalTasks)")
                                    .font(.caption2.monospaced())
                            }
                            .foregroundStyle(
                                session.stats.doneTasks == session.stats.totalTasks && session.stats.totalTasks > 0
                                    ? Color.green.opacity(0.7)
                                    : tc.tertiaryText
                            )
                        }

                        HStack(spacing: 3) {
                            Image(systemName: "person.2")
                                .font(.caption2)
                            Text("\(session.stats.agents)")
                                .font(.caption2.monospaced())
                        }
                        .foregroundStyle(tc.tertiaryText)

                        Spacer(minLength: 0)
                    }
                }

                Spacer(minLength: 4)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(rowBackground)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            withAnimation(.easeOut(duration: 0.1)) {
                isHovering = hovering
            }
        }
    }

    @ViewBuilder
    private var rowBackground: some View {
        if isSelected {
            tc.surface1
                .clipShape(RoundedRectangle(cornerRadius: 6))
        } else if isHovering {
            tc.surface0.opacity(0.5)
                .clipShape(RoundedRectangle(cornerRadius: 6))
        } else {
            Color.clear
        }
    }
}

// MARK: - Agent Status Icon

private struct AgentStatusIcon: View {
    @Environment(\.themeColors) private var tc
    let activeAgents: Int

    @State private var isPulsing = false

    private var isActive: Bool { activeAgents > 0 }

    var body: some View {
        ZStack {
            Circle()
                .fill(isActive ? Color.green : tc.surface2)
                .frame(width: 8, height: 8)

            if isActive {
                Circle()
                    .fill(Color.green.opacity(0.3))
                    .frame(width: 14, height: 14)
                    .opacity(isPulsing ? 0 : 0.6)
                    .animation(
                        .easeInOut(duration: 1.2).repeatForever(autoreverses: false),
                        value: isPulsing
                    )
                    .onAppear { isPulsing = true }
            }
        }
        .frame(width: 16, height: 16)
    }
}

// MARK: - Connection Indicator

private struct ConnectionIndicator: View {
    @Environment(\.themeColors) private var tc
    let isConnected: Bool
    let isSSE: Bool

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(isConnected ? .green : .red)
                .frame(width: 6, height: 6)

            Text(statusLabel)
                .font(.caption2.weight(.medium))
                .foregroundStyle(tc.tertiaryText)
        }
    }

    private var statusLabel: String {
        if !isConnected { return "Offline" }
        return isSSE ? "Live" : "Polling"
    }
}
