import Combine
import Foundation

@MainActor
final class SessionCanvasService: ObservableObject {
    @Published var layout: CanvasLayout = CanvasLayout()

    private let client: CommandCenterClient
    private let persistence: LayoutPersistenceService?
    private var layoutObserver: AnyCancellable?

    init(client: CommandCenterClient, persistence: LayoutPersistenceService? = nil) {
        self.client = client
        self.persistence = persistence

        // Auto-save layout on every change (debounced by persistence service)
        layoutObserver = $layout
            .dropFirst() // skip initial empty value
            .removeDuplicates()
            .sink { [weak self] newLayout in
                self?.persistCurrentLayout(newLayout)
            }
    }

    /// Build a canvas workspace from a tmux-ide session's pane layout.
    /// Checks for persisted layout first; falls back to auto-generated from panes.
    func loadSession(name: String) async {
        do {
            let panes = try await client.fetchPanes(session: name)
            let livePaneIDs = Set(panes.map(\.id))

            // Try to restore persisted layout
            if let restored = persistence?.load(session: name, livePaneIDs: livePaneIDs),
               !restored.workspaces.isEmpty {
                // Update pane titles from live data (titles may have changed)
                var updated = restored
                let titleByPaneID = Dictionary(panes.map { ($0.id, $0.title) }, uniquingKeysWith: { _, b in b })
                for wsIdx in updated.workspaces.indices {
                    for colIdx in updated.workspaces[wsIdx].columns.indices {
                        for itemIdx in updated.workspaces[wsIdx].columns[colIdx].items.indices {
                            if case .terminal(let paneId) = updated.workspaces[wsIdx].columns[colIdx].items[itemIdx].ref {
                                updated.workspaces[wsIdx].columns[colIdx].items[itemIdx].paneTitle = titleByPaneID[paneId]
                            }
                        }
                    }
                }

                // Add any new panes not in the persisted layout
                let persistedPaneIDs = Set(
                    updated.workspaces
                        .flatMap(\.columns)
                        .flatMap(\.items)
                        .compactMap { item -> String? in
                            if case .terminal(let id) = item.ref { return id }
                            return nil
                        }
                )
                let newPanes = panes.filter { !persistedPaneIDs.contains($0.id) }
                if !newPanes.isEmpty, let wsIdx = updated.workspaces.firstIndex(where: { $0.sessionName == name }) {
                    let newItems = newPanes.map { CanvasItem(ref: .terminal(paneId: $0.id), paneTitle: $0.title) }
                    let newColumn = CanvasColumn(items: newItems)
                    updated.workspaces[wsIdx].columns.append(newColumn)
                }

                // Merge restored workspace into existing layout (don't replace other sessions)
                if let restoredWorkspace = updated.workspaces.first {
                    if let existingIdx = layout.workspaces.firstIndex(where: { $0.sessionName == name }) {
                        layout.workspaces[existingIdx] = restoredWorkspace
                    } else {
                        layout.workspaces.append(restoredWorkspace)
                    }
                    layout.camera = updated.camera
                    layout.isOverviewOpen = updated.isOverviewOpen
                }
                return
            }

            // Fall back to auto-generated layout
            let workspace = buildWorkspace(sessionName: name, panes: panes)

            if let idx = layout.workspaces.firstIndex(where: { $0.sessionName == name }) {
                layout.workspaces[idx] = workspace
            } else {
                layout.workspaces.append(workspace)
            }

            layout.camera.activeWorkspaceID = workspace.id
            if let firstItem = workspace.columns.first?.items.first {
                layout.camera.focusedItemID = firstItem.id
                layout.camera.activeColumnID = workspace.columns.first?.id
            }
        } catch {
            // Session may have vanished
        }
    }

    /// Flush pending saves for all active sessions (call on app termination).
    func flushPendingSaves() {
        guard let activeWorkspace = layout.workspaces.first(where: { $0.id == layout.camera.activeWorkspaceID }) else { return }
        var sessionLayout = CanvasLayout()
        sessionLayout.workspaces = [activeWorkspace]
        sessionLayout.camera = scopedCamera(for: activeWorkspace, from: layout.camera)
        sessionLayout.isOverviewOpen = layout.isOverviewOpen
        persistence?.flushAll(layouts: [activeWorkspace.sessionName: sessionLayout])
    }

    // MARK: - Private

    private func persistCurrentLayout(_ newLayout: CanvasLayout) {
        guard let persistence else { return }
        for workspace in newLayout.workspaces {
            guard newLayout.camera.activeWorkspaceID == workspace.id else { continue }
            var sessionLayout = CanvasLayout()
            sessionLayout.workspaces = [workspace]
            sessionLayout.camera = scopedCamera(for: workspace, from: newLayout.camera)
            sessionLayout.isOverviewOpen = newLayout.isOverviewOpen
            persistence.save(session: workspace.sessionName, layout: sessionLayout)
        }
    }

    /// Returns camera state scoped to a specific workspace — clears IDs that
    /// belong to a different workspace so they don't leak across sessions.
    private func scopedCamera(for workspace: CanvasWorkspace, from camera: CameraState) -> CameraState {
        guard camera.activeWorkspaceID == workspace.id else {
            // Camera is pointing at a different workspace; save empty camera for this session
            return CameraState()
        }
        let columnIDs = Set(workspace.columns.map(\.id))
        let itemIDs = Set(workspace.columns.flatMap(\.items).map(\.id))
        var scoped = CameraState()
        scoped.activeWorkspaceID = workspace.id
        if let colID = camera.activeColumnID, columnIDs.contains(colID) {
            scoped.activeColumnID = colID
        }
        if let itemID = camera.focusedItemID, itemIDs.contains(itemID) {
            scoped.focusedItemID = itemID
        }
        return scoped
    }

    private func buildWorkspace(sessionName: String, panes: [TmuxIdePane]) -> CanvasWorkspace {
        // Architecture: tmux is the runtime, the app is the IDE frame.
        //
        // Left (large): tmux session — all agents, full pane layout
        // Right (sidebar): native widgets — mission control, browser, workflow

        var columns: [CanvasColumn] = []

        // Column 1: Big tmux terminal — takes 70%+ of the space
        let tmuxTile = CanvasItem(
            ref: .terminal(paneId: sessionName),
            preferredHeight: 900,
            paneTitle: sessionName
        )
        columns.append(CanvasColumn(items: [tmuxTile], preferredWidth: 3000))

        // Column 2: Stacked widget tiles running OpenTUI widgets in Ghostty
        // Each command cd's to the project root first so bunfig.toml resolves
        var widgetItems: [CanvasItem] = []

        // Mission Control — the unified TUI dashboard
        // Must cd to project root first so bunfig.toml preload resolves @opentui/solid
        let mcCmd = "cd $(tmux display-message -t \(sessionName) -p '#{pane_current_path}') && bun src/widgets/mission-control/index.tsx --session=\(sessionName) --dir=$(pwd)"
        widgetItems.append(CanvasItem(
            ref: .widget(command: mcCmd),
            preferredHeight: 350,
            paneTitle: "Mission Control"
        ))

        // Explorer — file tree navigator
        let explorerCmd = "cd $(tmux display-message -t \(sessionName) -p '#{pane_current_path}') && bun src/widgets/explorer/index.tsx --session=\(sessionName) --dir=$(pwd)"
        widgetItems.append(CanvasItem(
            ref: .widget(command: explorerCmd),
            preferredHeight: 300,
            paneTitle: "Explorer"
        ))

        // Browser — command-center dashboard
        let port = 4000
        widgetItems.append(CanvasItem(
            ref: .browser(url: "http://localhost:\(port)"),
            preferredHeight: 250,
            paneTitle: "Browser"
        ))

        columns.append(CanvasColumn(items: widgetItems, preferredWidth: 450))

        return CanvasWorkspace(sessionName: sessionName, columns: columns)
    }
}
