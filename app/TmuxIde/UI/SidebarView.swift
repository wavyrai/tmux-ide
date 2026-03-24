import SwiftUI

struct SidebarView: View {
    @EnvironmentObject var coordinator: AppCoordinator
    @EnvironmentObject var discovery: SessionDiscoveryService
    @EnvironmentObject var connectionManager: ConnectionManager

    private var hasRemoteTargets: Bool {
        connectionManager.targets.contains { !$0.isLocal }
    }

    var body: some View {
        List(selection: Binding(
            get: { coordinator.selectedSession },
            set: { name in
                if let name { coordinator.selectSession(name) }
            }
        )) {
            if hasRemoteTargets {
                // Group sessions by endpoint
                ForEach(connectionManager.targets) { target in
                    let sessions = connectionManager.aggregatedSessions.filter {
                        $0.endpointID == target.id
                    }
                    if !sessions.isEmpty {
                        Section {
                            ForEach(sessions) { session in
                                SessionRowView(session: session.overview)
                                    .tag(session.overview.name)
                            }
                        } header: {
                            HStack {
                                Text(target.label)
                                Spacer()
                                Circle()
                                    .fill(healthColor(for: target.id))
                                    .frame(width: 8, height: 8)
                            }
                        }
                    }
                }
            } else {
                // Single-endpoint flat list (original behavior)
                Section {
                    ForEach(discovery.sessions) { session in
                        SessionRowView(session: session)
                            .tag(session.name)
                    }
                } header: {
                    HStack(spacing: 6) {
                        Text("Sessions")
                        Spacer()
                        if discovery.isSSEConnected {
                            Image(systemName: "antenna.radiowaves.left.and.right")
                                .font(.caption2)
                                .foregroundStyle(.green)
                                .help("Real-time updates via SSE")
                        }
                        Circle()
                            .fill(discovery.isConnected ? .green : .red)
                            .frame(width: 8, height: 8)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await discovery.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help("Refresh sessions")
            }
        }
    }

    private func healthColor(for targetID: UUID) -> Color {
        switch connectionManager.health[targetID] {
        case .reachable: .green
        case .unreachable: .red
        case .unknown, .none: .gray
        }
    }
}

struct SessionRowView: View {
    let session: SessionOverview

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(session.name)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                if session.stats.activeAgents > 0 {
                    HStack(spacing: 2) {
                        Image(systemName: "bolt.fill")
                            .font(.caption2)
                        Text("\(session.stats.activeAgents)")
                            .font(.caption2)
                    }
                    .foregroundStyle(.green)
                }
            }

            if let mission = session.mission {
                Text(mission.title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            HStack(spacing: 12) {
                Label("\(session.stats.totalTasks)", systemImage: "checklist")
                Label("\(session.stats.doneTasks)/\(session.stats.totalTasks)", systemImage: "checkmark.circle")
                Label("\(session.stats.agents)", systemImage: "person.2")
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
    }
}
