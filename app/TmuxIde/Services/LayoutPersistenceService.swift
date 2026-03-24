import Foundation

// MARK: - Schema

enum LayoutPersistenceSchema {
    static let currentVersion = 1
}

struct PersistedLayoutPayload: Codable {
    var schemaVersion: Int = LayoutPersistenceSchema.currentVersion
    var layout: CanvasLayout
}

// MARK: - Layout Persistence Service

/// Persists CanvasLayout per session to ~/Library/Application Support/tmux-ide-app/layouts/{sessionName}.json.
/// Saves are debounced (200ms). On load: validates schema version, prunes orphaned pane refs,
/// resets camera if focused item is gone. Corrupt files are backed up as .corrupt.{timestamp}.json.
@MainActor
final class LayoutPersistenceService {
    private let layoutsDirectory: URL
    private let fileManager = FileManager.default
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }()
    private let decoder = JSONDecoder()

    /// Debounce work items keyed by session name.
    private var pendingSaves: [String: DispatchWorkItem] = [:]

    /// Debounce interval in seconds.
    private let debounceInterval: TimeInterval = 0.2

    init(appSupportDirectory: URL) {
        self.layoutsDirectory = appSupportDirectory.appendingPathComponent("layouts", isDirectory: true)
        ensureDirectory()
    }

    // MARK: - Public API

    /// Load persisted layout for a session, pruning orphaned pane refs.
    /// Returns nil if no persisted layout exists or if data is corrupt (backs up corrupt files).
    func load(session: String, livePaneIDs: Set<String>) -> CanvasLayout? {
        let fileURL = layoutFileURL(for: session)
        guard fileManager.fileExists(atPath: fileURL.path) else { return nil }

        let data: Data
        do {
            data = try Data(contentsOf: fileURL)
        } catch {
            return nil
        }

        let payload: PersistedLayoutPayload
        do {
            payload = try decoder.decode(PersistedLayoutPayload.self, from: data)
        } catch {
            backupCorruptFile(at: fileURL)
            return nil
        }

        guard payload.schemaVersion <= LayoutPersistenceSchema.currentVersion else {
            // Future schema version — don't touch the file, just ignore it
            return nil
        }

        var layout = payload.layout
        pruneOrphanedRefs(&layout, livePaneIDs: livePaneIDs)
        resetCameraIfNeeded(&layout)
        return layout
    }

    /// Schedule a debounced save of the layout for a session.
    func save(session: String, layout: CanvasLayout) {
        pendingSaves[session]?.cancel()

        let work = DispatchWorkItem { [weak self] in
            self?.writeLayout(session: session, layout: layout)
        }
        pendingSaves[session] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + debounceInterval, execute: work)
    }

    /// Immediately flush any pending save for a session (e.g. on app termination).
    func flush(session: String) {
        guard let work = pendingSaves.removeValue(forKey: session) else { return }
        work.cancel()
        // The layout is not directly accessible here; callers should save explicitly before flush.
    }

    /// Flush all pending saves with the provided layouts.
    func flushAll(layouts: [String: CanvasLayout]) {
        for (session, layout) in layouts {
            pendingSaves[session]?.cancel()
            pendingSaves.removeValue(forKey: session)
            writeLayout(session: session, layout: layout)
        }
    }

    /// Remove persisted layout for a session.
    func clear(session: String) {
        pendingSaves[session]?.cancel()
        pendingSaves.removeValue(forKey: session)
        let fileURL = layoutFileURL(for: session)
        try? fileManager.removeItem(at: fileURL)
    }

    // MARK: - File I/O

    private func writeLayout(session: String, layout: CanvasLayout) {
        let payload = PersistedLayoutPayload(layout: layout)
        do {
            let data = try encoder.encode(payload)
            try data.write(to: layoutFileURL(for: session), options: .atomic)
        } catch {
            // Best-effort persistence — don't crash on write failure
        }
    }

    private func layoutFileURL(for session: String) -> URL {
        // Sanitize session name for use as filename
        let safe = session
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
        return layoutsDirectory.appendingPathComponent("\(safe).json", isDirectory: false)
    }

    private func ensureDirectory() {
        if !fileManager.fileExists(atPath: layoutsDirectory.path) {
            try? fileManager.createDirectory(at: layoutsDirectory, withIntermediateDirectories: true)
        }
    }

    // MARK: - Corrupt File Recovery

    private func backupCorruptFile(at url: URL) {
        let timestamp = Int(Date().timeIntervalSince1970)
        let backupName = url.deletingPathExtension().lastPathComponent + ".corrupt.\(timestamp).json"
        let backupURL = url.deletingLastPathComponent().appendingPathComponent(backupName)
        try? fileManager.moveItem(at: url, to: backupURL)
    }

    // MARK: - Pruning & Validation

    /// Remove items that reference pane IDs no longer present in the live tmux session.
    private func pruneOrphanedRefs(_ layout: inout CanvasLayout, livePaneIDs: Set<String>) {
        for wsIdx in layout.workspaces.indices {
            for colIdx in layout.workspaces[wsIdx].columns.indices {
                layout.workspaces[wsIdx].columns[colIdx].items.removeAll { item in
                    switch item.ref {
                    case .terminal(let paneId):
                        return !livePaneIDs.contains(paneId)
                    case .browser, .dashboard:
                        return false
                    }
                }
            }
            // Remove empty columns
            layout.workspaces[wsIdx].columns.removeAll { $0.items.isEmpty }
        }
        // Remove empty workspaces
        layout.workspaces.removeAll { $0.columns.isEmpty }
    }

    /// If the camera references items/columns/workspaces that no longer exist, reset to defaults.
    private func resetCameraIfNeeded(_ layout: inout CanvasLayout) {
        let allWorkspaceIDs = Set(layout.workspaces.map(\.id))
        let allColumnIDs = Set(layout.workspaces.flatMap(\.columns).map(\.id))
        let allItemIDs = Set(layout.workspaces.flatMap(\.columns).flatMap(\.items).map(\.id))

        // Validate activeWorkspaceID
        if let wsID = layout.camera.activeWorkspaceID, !allWorkspaceIDs.contains(wsID) {
            layout.camera.activeWorkspaceID = layout.workspaces.first?.id
        }

        // Validate activeColumnID
        if let colID = layout.camera.activeColumnID, !allColumnIDs.contains(colID) {
            let activeWS = layout.workspaces.first { $0.id == layout.camera.activeWorkspaceID }
            layout.camera.activeColumnID = activeWS?.columns.first?.id
        }

        // Validate focusedItemID
        if let itemID = layout.camera.focusedItemID, !allItemIDs.contains(itemID) {
            let activeWS = layout.workspaces.first { $0.id == layout.camera.activeWorkspaceID }
            let activeCol = activeWS?.columns.first { $0.id == layout.camera.activeColumnID }
            layout.camera.focusedItemID = activeCol?.items.first?.id
        }

        // If workspace is nil but we have workspaces, pick the first
        if layout.camera.activeWorkspaceID == nil, let first = layout.workspaces.first {
            layout.camera.activeWorkspaceID = first.id
            layout.camera.activeColumnID = first.columns.first?.id
            layout.camera.focusedItemID = first.columns.first?.items.first?.id
        }
    }
}
