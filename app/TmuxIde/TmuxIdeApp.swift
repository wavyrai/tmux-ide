// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel
import SwiftUI

/// tmux-ide macOS menu bar app.
///
/// Provides a status-bar icon that shows tmux session state, daemon status,
/// and orchestrator progress. The heavy lifting (tmux polling, REST enrichment)
/// is done by `TmuxSessionMonitor` and `ServerManager`.
@main
struct TmuxIdeApp: App {
    @State private var sessionMonitor = TmuxSessionMonitor.shared
    @State private var serverManager = ServerManager.shared

    var body: some Scene {
        // Menu bar extra — the primary UI surface
        MenuBarExtra("tmux-ide", systemImage: "terminal") {
            TmuxIdeMenuView()
                .environment(sessionMonitor)
                .environment(serverManager)
                .withTmuxIdeServices()
        }
        .menuBarExtraStyle(.window)

        // Settings window
        Settings {
            SettingsView()
        }
    }

    init() {
        // Start background monitors
        Task { @MainActor in
            TmuxSessionMonitor.shared.start()
            ServerManager.shared.start()
        }
    }
}
