import SwiftUI

struct CanvasContainerView: View {
    let sessionName: String

    @EnvironmentObject var coordinator: AppCoordinator
    @EnvironmentObject var canvasService: SessionCanvasService
    @StateObject private var gestureManager = CanvasGestureManager()
    @StateObject private var camera = CameraStateManager()
    @FocusState private var canvasFocused: Bool
    @State private var containerSize: CGSize = .zero

    var workspace: CanvasWorkspace? {
        canvasService.layout.workspaces.first { $0.sessionName == sessionName }
    }

    var body: some View {
        Group {
            if let workspace {
                canvasContent(workspace: workspace)
            } else {
                loadingPlaceholder
            }
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(sessionName)
                    .font(.headline)
            }
            ToolbarItem(placement: .automatic) {
                overviewToggleButton
            }
        }
        .onAppear {
            gestureManager.attach(camera: camera)
            camera.sync(from: canvasService.layout.camera)
            gestureManager.scale = camera.isOverview
                ? CanvasMetrics.overviewScale
                : CanvasMetrics.focusedScale
        }
        .onChange(of: canvasService.layout.camera) { newCamera in
            camera.sync(from: newCamera)
        }
        .onChange(of: camera.isOverview) { isOverview in
            canvasFocused = isOverview
            withAnimation(CameraStateManager.cameraSpring) {
                gestureManager.scale = isOverview
                    ? CanvasMetrics.overviewScale
                    : CanvasMetrics.focusedScale
            }
        }
        .onChange(of: coordinator.pendingCanvasAction) { _, action in
            guard let action else { return }
            coordinator.pendingCanvasAction = nil
            handleCanvasAction(action)
        }
    }

    // MARK: - Toolbar

    private var overviewToggleButton: some View {
        Button {
            camera.toggleOverview(
                layout: canvasService.layout,
                containerSize: containerSize
            )
        } label: {
            Image(systemName: camera.isOverview
                ? "rectangle.center.inset.filled"
                : "rectangle.3.group")
        }
        .help(camera.isOverview ? "Exit overview (Enter)" : "Overview (⌘⇧O)")
    }

    // MARK: - Canvas Content

    @ViewBuilder
    private func canvasContent(workspace: CanvasWorkspace) -> some View {
        GeometryReader { proxy in
            CanvasGestureOverlay(
                gestureManager: gestureManager,
                camera: camera
            ) {
                HStack(alignment: .top, spacing: 16) {
                    ForEach(workspace.columns) { column in
                        overviewAwareColumn(column: column)
                    }
                }
                .padding(20)
            }
            .background(Color(nsColor: .windowBackgroundColor))
            .preference(key: ContainerSizeKey.self, value: proxy.size)
        }
        .onPreferenceChange(ContainerSizeKey.self) { containerSize = $0 }
        .focusable()
        .focused($canvasFocused)
        .onKeyPress(.leftArrow) { handleOverviewNav { overviewNavigateLeft(in: workspace) } }
        .onKeyPress(.rightArrow) { handleOverviewNav { overviewNavigateRight(in: workspace) } }
        .onKeyPress(.upArrow) { handleOverviewNav { overviewNavigateUp(in: workspace) } }
        .onKeyPress(.downArrow) { handleOverviewNav { overviewNavigateDown(in: workspace) } }
        .onKeyPress(.return) { handleOverviewEnter() }
    }

    // MARK: - Column with Overview Decorations

    @ViewBuilder
    private func overviewAwareColumn(column: CanvasColumn) -> some View {
        CanvasColumnView(
            column: column,
            sessionName: sessionName,
            baseURL: coordinator.connectionTarget.baseURL
        )
        .opacity(overviewColumnOpacity(for: column))
        .overlay {
            if camera.isOverview && camera.activeColumnID == column.id {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Color.accentColor.opacity(0.6), lineWidth: 3)
                    .animation(CameraStateManager.cameraSpring, value: camera.activeColumnID)
            }
        }
        .overlay {
            if camera.isOverview {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture {
                        focusFromOverview(column: column)
                    }
            }
        }
    }

    /// Dim non-active columns slightly in overview for visual hierarchy.
    private func overviewColumnOpacity(for column: CanvasColumn) -> Double {
        guard camera.isOverview, let activeID = camera.activeColumnID else { return 1.0 }
        return column.id == activeID ? 1.0 : 0.7
    }

    // MARK: - Overview Click-to-Focus

    private func focusFromOverview(column: CanvasColumn) {
        if let itemID = column.items.first?.id {
            camera.focusItem(itemID, in: canvasService.layout, containerSize: containerSize)
        } else {
            camera.focusColumn(column.id, in: canvasService.layout, containerSize: containerSize)
        }
    }

    // MARK: - Overview Arrow Key Navigation
    //
    // Moves the selection highlight without exiting overview mode.
    // The CameraStateManager.navigate* methods call focusColumn/focusItem
    // which set isOverview = false, so overview navigation is handled here.

    private func handleOverviewNav(_ action: () -> Void) -> KeyPress.Result {
        guard camera.isOverview else { return .ignored }
        action()
        return .handled
    }

    private func handleOverviewEnter() -> KeyPress.Result {
        guard camera.isOverview else { return .ignored }
        if let itemID = camera.focusedItemID {
            camera.focusItem(itemID, in: canvasService.layout, containerSize: containerSize)
        } else if let columnID = camera.activeColumnID {
            camera.focusColumn(columnID, in: canvasService.layout, containerSize: containerSize)
        }
        return .handled
    }

    private func overviewNavigateLeft(in workspace: CanvasWorkspace) {
        guard let colIndex = activeColumnIndex(in: workspace), colIndex > 0 else { return }
        let target = workspace.columns[colIndex - 1]
        withAnimation(CameraStateManager.cameraSpring) {
            camera.activeColumnID = target.id
            camera.focusedItemID = target.items.first?.id
        }
    }

    private func overviewNavigateRight(in workspace: CanvasWorkspace) {
        guard let colIndex = activeColumnIndex(in: workspace),
              colIndex < workspace.columns.count - 1 else { return }
        let target = workspace.columns[colIndex + 1]
        withAnimation(CameraStateManager.cameraSpring) {
            camera.activeColumnID = target.id
            camera.focusedItemID = target.items.first?.id
        }
    }

    private func overviewNavigateUp(in workspace: CanvasWorkspace) {
        guard let colIndex = activeColumnIndex(in: workspace) else { return }
        let column = workspace.columns[colIndex]
        guard let itemIndex = activeItemIndex(in: column), itemIndex > 0 else { return }
        withAnimation(CameraStateManager.cameraSpring) {
            camera.focusedItemID = column.items[itemIndex - 1].id
        }
    }

    private func overviewNavigateDown(in workspace: CanvasWorkspace) {
        guard let colIndex = activeColumnIndex(in: workspace) else { return }
        let column = workspace.columns[colIndex]
        guard let itemIndex = activeItemIndex(in: column),
              itemIndex < column.items.count - 1 else { return }
        withAnimation(CameraStateManager.cameraSpring) {
            camera.focusedItemID = column.items[itemIndex + 1].id
        }
    }

    // MARK: - Index Resolution

    private func activeColumnIndex(in workspace: CanvasWorkspace) -> Int? {
        guard let activeID = camera.activeColumnID else {
            if let first = workspace.columns.first {
                camera.activeColumnID = first.id
                camera.focusedItemID = first.items.first?.id
                return 0
            }
            return nil
        }
        return workspace.columns.firstIndex { $0.id == activeID }
    }

    private func activeItemIndex(in column: CanvasColumn) -> Int? {
        guard let itemID = camera.focusedItemID else {
            return column.items.isEmpty ? nil : 0
        }
        return column.items.firstIndex { $0.id == itemID }
    }

    // MARK: - Keyboard Shortcut Actions

    private func handleCanvasAction(_ actionId: String) {
        let layout = canvasService.layout

        switch actionId {
        case "focus-next":
            camera.navigateRight(in: layout, containerSize: containerSize)
        case "focus-prev":
            camera.navigateLeft(in: layout, containerSize: containerSize)
        case "focus-up":
            camera.navigateUp(in: layout, containerSize: containerSize)
        case "focus-down":
            camera.navigateDown(in: layout, containerSize: containerSize)
        case "toggle-overview":
            camera.toggleOverview(layout: layout, containerSize: containerSize)
        default:
            break
        }
    }

    // MARK: - Loading Placeholder

    private var loadingPlaceholder: some View {
        VStack {
            ProgressView()
            Text("Loading \(sessionName)...")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Container Size Preference Key

private struct ContainerSizeKey: PreferenceKey {
    static var defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) {
        value = nextValue()
    }
}
