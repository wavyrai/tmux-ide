import Foundation

// Canvas layout hierarchy: Workspace > Column > Item
// Adapted from IDX0's Niri canvas model

enum TileRef: Codable, Equatable {
    case terminal(paneId: String)
    case browser(url: String?)
    case dashboard
    case widget(command: String)
}

struct CanvasItem: Identifiable, Codable, Equatable {
    let id: UUID
    let ref: TileRef
    var preferredHeight: Double?
    /// The tmux pane title, used for agent status badge lookups.
    var paneTitle: String?

    init(ref: TileRef, preferredHeight: Double? = nil, paneTitle: String? = nil) {
        self.id = UUID()
        self.ref = ref
        self.preferredHeight = preferredHeight
        self.paneTitle = paneTitle
    }
}

struct CanvasColumn: Identifiable, Codable, Equatable {
    let id: UUID
    var items: [CanvasItem]
    var preferredWidth: Double?

    init(items: [CanvasItem] = [], preferredWidth: Double? = nil) {
        self.id = UUID()
        self.items = items
        self.preferredWidth = preferredWidth
    }
}

struct CanvasWorkspace: Identifiable, Codable, Equatable {
    let id: UUID
    let sessionName: String
    var columns: [CanvasColumn]

    init(sessionName: String, columns: [CanvasColumn] = []) {
        self.id = UUID()
        self.sessionName = sessionName
        self.columns = columns
    }
}

struct CameraState: Codable, Equatable {
    var activeWorkspaceID: UUID?
    var activeColumnID: UUID?
    var focusedItemID: UUID?
}

struct CanvasLayout: Codable, Equatable {
    var workspaces: [CanvasWorkspace]
    var camera: CameraState
    var isOverviewOpen: Bool

    init() {
        self.workspaces = []
        self.camera = CameraState()
        self.isOverviewOpen = false
    }
}
