import SwiftUI

struct MainWindowView: View {
    @EnvironmentObject var coordinator: AppCoordinator
    @EnvironmentObject var discovery: SessionDiscoveryService

    var body: some View {
        ZStack {
            NavigationSplitView {
                SidebarView()
            } detail: {
                if let session = coordinator.selectedSession {
                    CanvasContainerView(sessionName: session)
                } else {
                    VStack(spacing: 16) {
                        Image(systemName: "rectangle.split.3x3")
                            .font(.system(size: 48))
                            .foregroundStyle(.tertiary)
                        Text("Select a session")
                            .font(.title2)
                            .foregroundStyle(.secondary)
                        if !discovery.isConnected {
                            HStack(spacing: 8) {
                                ProgressView()
                                    .scaleEffect(0.7)
                                Text("Connecting to command-center...")
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationSplitViewColumnWidth(min: 200, ideal: 260, max: 350)

            // Command palette overlay (Cmd+K)
            if coordinator.showCommandPalette {
                CommandPaletteOverlay(
                    isPresented: $coordinator.showCommandPalette,
                    actions: commandActions
                )
                .transition(.opacity.combined(with: .scale(scale: 0.97)))
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    coordinator.showConnectionSheet = true
                } label: {
                    Image(systemName: "network")
                }
                .help("Manage connections")
            }
        }
        .sheet(isPresented: $coordinator.showConnectionSheet) {
            ConnectionSheet()
                .environmentObject(coordinator.connectionManager)
        }
    }

    // MARK: - Registered actions

    private var commandActions: [CommandAction] {
        let hasSession = coordinator.selectedSession != nil
        let registry = coordinator.shortcutRegistry
        return [
            CommandAction(
                id: "focus-next",
                title: "Focus Next Column",
                subtitle: "Move focus to the next column",
                icon: "arrow.right.square",
                shortcut: registry.label(for: "focus-next"),
                isEnabled: hasSession
            ) { coordinator.performAction("focus-next") },
            CommandAction(
                id: "focus-prev",
                title: "Focus Previous Column",
                subtitle: "Move focus to the previous column",
                icon: "arrow.left.square",
                shortcut: registry.label(for: "focus-prev"),
                isEnabled: hasSession
            ) { coordinator.performAction("focus-prev") },
            CommandAction(
                id: "focus-up",
                title: "Focus Item Above",
                subtitle: "Move focus to the item above in this column",
                icon: "arrow.up.square",
                shortcut: registry.label(for: "focus-up"),
                isEnabled: hasSession
            ) { coordinator.performAction("focus-up") },
            CommandAction(
                id: "focus-down",
                title: "Focus Item Below",
                subtitle: "Move focus to the item below in this column",
                icon: "arrow.down.square",
                shortcut: registry.label(for: "focus-down"),
                isEnabled: hasSession
            ) { coordinator.performAction("focus-down") },
            CommandAction(
                id: "toggle-overview",
                title: "Toggle Overview",
                subtitle: "Zoom out to see all tiles at a glance",
                icon: "square.grid.3x3",
                shortcut: registry.label(for: "toggle-overview"),
                isEnabled: hasSession
            ) { coordinator.performAction("toggle-overview") },
            CommandAction(
                id: "add-terminal",
                title: "Add Terminal Tile",
                subtitle: "Add a new terminal tile to the canvas",
                icon: "terminal",
                shortcut: registry.label(for: "add-terminal"),
                isEnabled: hasSession
            ) { coordinator.performAction("add-terminal") },
            CommandAction(
                id: "add-browser",
                title: "Add Browser Tile",
                subtitle: "Add a new browser tile to the canvas",
                icon: "globe",
                shortcut: registry.label(for: "add-browser"),
                isEnabled: hasSession
            ) { coordinator.performAction("add-browser") },
            CommandAction(
                id: "add-dashboard",
                title: "Add Dashboard Tile",
                subtitle: "Add an orchestrator dashboard tile",
                icon: "chart.bar",
                isEnabled: hasSession
            ) { coordinator.performAction("add-dashboard") },
            CommandAction(
                id: "refresh-sessions",
                title: "Refresh Sessions",
                subtitle: "Reload session list from command-center",
                icon: "arrow.clockwise"
            ) {
                Task { await discovery.refresh() }
            },
            CommandAction(
                id: "manage-connections",
                title: "Manage Connections",
                subtitle: "Add or remove remote endpoints",
                icon: "network"
            ) {
                coordinator.showConnectionSheet = true
            },
            CommandAction(
                id: "open-settings",
                title: "Open Settings",
                subtitle: "Open app preferences",
                icon: "gear",
                shortcut: "⌘,"
            ) { /* Future: coordinator.showSettings() */ },
        ]
    }
}
