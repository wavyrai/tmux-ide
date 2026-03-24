import SwiftUI

@main
struct TmuxIdeApp: App {
    @StateObject private var coordinator = AppCoordinator()

    private var hasSession: Bool { coordinator.selectedSession != nil }

    var body: some Scene {
        WindowGroup {
            MainWindowView()
                .background(WindowConfigurator())
                .environment(\.themeColors, AppThemeColors.default)
                .environmentObject(coordinator)
                .environmentObject(coordinator.discoveryService)
                .environmentObject(coordinator.canvasService)
                .environmentObject(coordinator.connectionManager)
                .frame(minWidth: 800, minHeight: 500)
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                    coordinator.prepareForTermination()
                }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1400, height: 900)

        Settings {
            SettingsView()
                .environmentObject(coordinator.connectionManager)
        }

        .commands {
            // MARK: Session menu (replaces File > New)

            CommandGroup(replacing: .newItem) {
                Button("New Session") {
                    // Future: coordinator.createNewSession()
                }
                .keyboardShortcut("n", modifiers: .command)

                Button("Close Session") {
                    coordinator.selectedSession = nil
                }
                .keyboardShortcut("w", modifiers: .command)
                .disabled(!hasSession)

                Divider()

                Button("Refresh Sessions") {
                    Task { await coordinator.discoveryService.refresh() }
                }
                .keyboardShortcut("r", modifiers: .command)

                Button("Manage Connections...") {
                    coordinator.showConnectionSheet = true
                }
            }

            // MARK: Canvas menu

            CommandMenu("Canvas") {
                Button("Toggle Overview") {
                    coordinator.performAction("toggle-overview")
                }
                .keyboardShortcut("o", modifiers: [.command, .shift])
                .disabled(!hasSession)

                Divider()

                Button("Focus Next Column") {
                    coordinator.performAction("focus-next")
                }
                .keyboardShortcut("]", modifiers: .command)
                .disabled(!hasSession)

                Button("Focus Previous Column") {
                    coordinator.performAction("focus-prev")
                }
                .keyboardShortcut("[", modifiers: .command)
                .disabled(!hasSession)

                Button("Focus Up") {
                    coordinator.performAction("focus-up")
                }
                .keyboardShortcut(.upArrow, modifiers: [.command, .option])
                .disabled(!hasSession)

                Button("Focus Down") {
                    coordinator.performAction("focus-down")
                }
                .keyboardShortcut(.downArrow, modifiers: [.command, .option])
                .disabled(!hasSession)

                Divider()

                Button("Zoom In") {
                    coordinator.performAction("zoom-in")
                }
                .keyboardShortcut("=", modifiers: .command)
                .disabled(!hasSession)

                Button("Zoom Out") {
                    coordinator.performAction("zoom-out")
                }
                .keyboardShortcut("-", modifiers: .command)
                .disabled(!hasSession)

                Button("Reset Zoom") {
                    coordinator.performAction("zoom-reset")
                }
                .keyboardShortcut("0", modifiers: .command)
                .disabled(!hasSession)
            }

            // MARK: Tile menu

            CommandMenu("Tile") {
                Button("Add Terminal") {
                    coordinator.performAction("add-terminal")
                }
                .keyboardShortcut("t", modifiers: .command)
                .disabled(!hasSession)

                Button("Add Browser") {
                    coordinator.performAction("add-browser")
                }
                .keyboardShortcut("b", modifiers: [.command, .shift])
                .disabled(!hasSession)

                Button("Add Dashboard") {
                    coordinator.performAction("add-dashboard")
                }
                .disabled(!hasSession)
            }

            // MARK: View menu additions

            CommandGroup(after: .toolbar) {
                Divider()

                Button("Command Palette...") {
                    coordinator.performAction("command-palette")
                }
                .keyboardShortcut("k", modifiers: .command)
            }
        }
    }
}
