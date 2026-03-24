import Foundation
import SwiftUI

@MainActor
final class AppCoordinator: ObservableObject {
    let paths: FileSystemPaths
    let connectionManager: ConnectionManager
    let discoveryService: SessionDiscoveryService
    let canvasService: SessionCanvasService
    let layoutPersistence: LayoutPersistenceService
    let shortcutRegistry: ShortcutRegistry
    private(set) var shortcutDispatcher: ShortcutDispatcher?

    @Published var selectedSession: String?
    @Published var showCommandPalette = false
    @Published var showConnectionSheet = false

    /// Action dispatched by a keyboard shortcut that requires canvas context
    /// (e.g., navigation). CanvasContainerView observes this and clears it after handling.
    @Published var pendingCanvasAction: String?

    init() {
        do {
            paths = try BootstrapCoordinator.makePaths()
        } catch {
            fatalError("Failed to create app directories: \(error)")
        }

        let cm = ConnectionManager(connectionsFile: paths.connectionsFile)
        connectionManager = cm
        discoveryService = SessionDiscoveryService(connectionManager: cm)

        let lps = LayoutPersistenceService(appSupportDirectory: paths.appSupportDirectory)
        layoutPersistence = lps

        // Use local client for canvas service (remote canvas comes later)
        let localClient = cm.localClient ?? CommandCenterClient(target: .localhost)
        canvasService = SessionCanvasService(client: localClient, persistence: lps)

        shortcutRegistry = ShortcutRegistry()

        discoveryService.start()

        // Wire keyboard shortcut dispatcher after all properties are initialized
        let dispatcher = ShortcutDispatcher(registry: shortcutRegistry) { [weak self] actionId in
            self?.performAction(actionId)
        }
        shortcutDispatcher = dispatcher
        dispatcher.start()
    }

    // MARK: - Action dispatch

    func performAction(_ actionId: String) {
        switch actionId {
        case "command-palette":
            toggleCommandPalette()

        case let id where id.hasPrefix("focus-session-"):
            let indexStr = id.replacingOccurrences(of: "focus-session-", with: "")
            if let index = Int(indexStr), index >= 1 {
                selectSessionByIndex(index - 1)
            }

        // Canvas-level actions — forward to the active CanvasContainerView
        case "focus-next", "focus-prev", "focus-up", "focus-down",
             "toggle-overview", "add-terminal", "add-browser":
            pendingCanvasAction = actionId

        default:
            break
        }
    }

    // MARK: - Session selection

    func selectSession(_ name: String) {
        selectedSession = name
        Task {
            await canvasService.loadSession(name: name)
        }
    }

    func selectSessionByIndex(_ index: Int) {
        let sessions = discoveryService.sessions
        guard index >= 0, index < sessions.count else { return }
        selectSession(sessions[index].name)
    }

    func toggleCommandPalette() {
        showCommandPalette.toggle()
    }

    func dismissCommandPalette() {
        showCommandPalette = false
    }

    func prepareForTermination() {
        canvasService.flushPendingSaves()
        shortcutDispatcher?.stop()
        discoveryService.stop()
    }
}
