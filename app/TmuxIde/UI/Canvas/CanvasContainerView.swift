import SwiftUI
import UniformTypeIdentifiers

struct CanvasContainerView: View {
    let sessionName: String

    @Environment(\.themeColors) private var themeColors
    @EnvironmentObject var coordinator: AppCoordinator
    @EnvironmentObject var canvasService: SessionCanvasService
    @StateObject private var gestureManager = CanvasGestureManager()
    @StateObject private var camera = CameraStateManager()
    @FocusState private var canvasFocused: Bool
    @State private var containerSize: CGSize = .zero
    @State private var draggedItemID: UUID?
    @State private var dropTargetColumnID: UUID?

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
                HStack(alignment: .top, spacing: 0) {
                    if camera.isOverview {
                        // Leading inter-column drop zone
                        interColumnDropZone(insertionIndex: 0, in: workspace)
                    }
                    ForEach(Array(workspace.columns.enumerated()), id: \.element.id) { index, column in
                        if index > 0 {
                            if camera.isOverview {
                                interColumnDropZone(insertionIndex: index, in: workspace)
                            } else {
                                // Horizontal resize handle between columns
                                ColumnResizeHandle(height: 400) { delta in
                                    resizeColumn(
                                        workspace.columns[index - 1].id,
                                        delta: delta,
                                        in: workspace
                                    )
                                }
                            }
                        }
                        overviewAwareColumn(column: column, workspace: workspace)
                    }
                    if camera.isOverview {
                        // Trailing inter-column drop zone
                        interColumnDropZone(insertionIndex: workspace.columns.count, in: workspace)
                    }
                }
                .padding(20)
            }
            .background(DotGridBackground(offsetX: camera.panOffset.x, offsetY: camera.panOffset.y))
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
    private func overviewAwareColumn(column: CanvasColumn, workspace: CanvasWorkspace) -> some View {
        CanvasColumnView(
            column: column,
            sessionName: sessionName,
            baseURL: (coordinator.connectionManager.targets.first ?? .localhost).baseURL,
            isOverview: camera.isOverview,
            draggedItemID: draggedItemID,
            onItemResize: { itemID, delta in
                resizeItem(itemID, delta: delta, columnID: column.id, in: workspace)
            },
            onDragStarted: { itemID in
                draggedItemID = itemID
            },
            onDragEnded: {
                draggedItemID = nil
                dropTargetColumnID = nil
            }
        )
        .opacity(overviewColumnOpacity(for: column))
        .overlay {
            if camera.isOverview && camera.activeColumnID == column.id && draggedItemID == nil {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(themeColors.accent.opacity(0.6), lineWidth: 3)
                    .animation(CameraStateManager.cameraSpring, value: camera.activeColumnID)
            }
        }
        .overlay {
            // Drop target highlight
            if camera.isOverview && dropTargetColumnID == column.id && draggedItemID != nil {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(themeColors.accent, lineWidth: 2)
                    .background(themeColors.accent.opacity(0.08).clipShape(RoundedRectangle(cornerRadius: 12)))
            }
        }
        .overlay {
            if camera.isOverview && draggedItemID == nil {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture {
                        focusFromOverview(column: column)
                    }
            }
        }
        .onDrop(of: [.text], isTargeted: Binding(
            get: { dropTargetColumnID == column.id },
            set: { targeted in
                if targeted {
                    dropTargetColumnID = column.id
                } else if dropTargetColumnID == column.id {
                    dropTargetColumnID = nil
                }
            }
        )) { providers in
            handleDrop(providers: providers, toColumnID: column.id, in: workspace)
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

    // MARK: - Drag & Drop (Overview Mode)

    @ViewBuilder
    private func interColumnDropZone(insertionIndex: Int, in workspace: CanvasWorkspace) -> some View {
        let isTargeted = draggedItemID != nil
        Rectangle()
            .fill(Color.clear)
            .frame(width: isTargeted ? 40 : 16)
            .frame(maxHeight: .infinity)
            .overlay {
                if draggedItemID != nil {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(themeColors.accent.opacity(0.4))
                        .frame(width: 3)
                }
            }
            .contentShape(Rectangle())
            .onDrop(of: [.text], isTargeted: .constant(false)) { providers in
                handleDropAsNewColumn(providers: providers, atIndex: insertionIndex, in: workspace)
            }
            .animation(.easeOut(duration: 0.15), value: draggedItemID != nil)
    }

    private func handleDrop(providers: [NSItemProvider], toColumnID: UUID, in workspace: CanvasWorkspace) -> Bool {
        guard camera.isOverview else { return false }
        guard let provider = providers.first(where: { $0.canLoadObject(ofClass: NSString.self) }) else { return false }
        provider.loadObject(ofClass: NSString.self) { object, _ in
            guard let string = object as? NSString,
                  let itemID = UUID(uuidString: String(string)) else { return }
            DispatchQueue.main.async {
                withAnimation(.spring(duration: 0.35, bounce: 0.15)) {
                    moveItem(itemID, toColumnID: toColumnID, in: workspace)
                }
                draggedItemID = nil
                dropTargetColumnID = nil
            }
        }
        return true
    }

    private func handleDropAsNewColumn(providers: [NSItemProvider], atIndex: Int, in workspace: CanvasWorkspace) -> Bool {
        guard camera.isOverview else { return false }
        guard let provider = providers.first(where: { $0.canLoadObject(ofClass: NSString.self) }) else { return false }
        provider.loadObject(ofClass: NSString.self) { object, _ in
            guard let string = object as? NSString,
                  let itemID = UUID(uuidString: String(string)) else { return }
            DispatchQueue.main.async {
                withAnimation(.spring(duration: 0.35, bounce: 0.15)) {
                    moveItemToNewColumn(itemID, atIndex: atIndex, in: workspace)
                }
                draggedItemID = nil
                dropTargetColumnID = nil
            }
        }
        return true
    }

    /// Move an item from its current column to the target column.
    private func moveItem(_ itemID: UUID, toColumnID: UUID, in workspace: CanvasWorkspace) {
        guard let wsIdx = canvasService.layout.workspaces.firstIndex(where: { $0.id == workspace.id }) else { return }

        // Find and remove from source column
        var item: CanvasItem?
        for colIdx in canvasService.layout.workspaces[wsIdx].columns.indices {
            if let itemIdx = canvasService.layout.workspaces[wsIdx].columns[colIdx].items.firstIndex(where: { $0.id == itemID }) {
                item = canvasService.layout.workspaces[wsIdx].columns[colIdx].items.remove(at: itemIdx)
                // Clean up empty columns
                if canvasService.layout.workspaces[wsIdx].columns[colIdx].items.isEmpty {
                    canvasService.layout.workspaces[wsIdx].columns.remove(at: colIdx)
                }
                break
            }
        }

        guard let item else { return }

        // Append to target column
        if let targetIdx = canvasService.layout.workspaces[wsIdx].columns.firstIndex(where: { $0.id == toColumnID }) {
            canvasService.layout.workspaces[wsIdx].columns[targetIdx].items.append(item)
        }
    }

    /// Move an item into a brand-new column at the given insertion index.
    private func moveItemToNewColumn(_ itemID: UUID, atIndex: Int, in workspace: CanvasWorkspace) {
        guard let wsIdx = canvasService.layout.workspaces.firstIndex(where: { $0.id == workspace.id }) else { return }

        // Find and remove from source column
        var item: CanvasItem?
        for colIdx in canvasService.layout.workspaces[wsIdx].columns.indices {
            if let itemIdx = canvasService.layout.workspaces[wsIdx].columns[colIdx].items.firstIndex(where: { $0.id == itemID }) {
                item = canvasService.layout.workspaces[wsIdx].columns[colIdx].items.remove(at: itemIdx)
                if canvasService.layout.workspaces[wsIdx].columns[colIdx].items.isEmpty {
                    canvasService.layout.workspaces[wsIdx].columns.remove(at: colIdx)
                }
                break
            }
        }

        guard let item else { return }

        let newColumn = CanvasColumn(items: [item])
        let clamped = min(atIndex, canvasService.layout.workspaces[wsIdx].columns.count)
        canvasService.layout.workspaces[wsIdx].columns.insert(newColumn, at: clamped)
    }

    // MARK: - Resize Actions

    private func resizeColumn(_ columnID: UUID, delta: CGFloat, in workspace: CanvasWorkspace) {
        guard abs(delta) > 0.5 else { return }
        guard let wsIdx = canvasService.layout.workspaces.firstIndex(where: { $0.id == workspace.id }),
              let colIdx = canvasService.layout.workspaces[wsIdx].columns.firstIndex(where: { $0.id == columnID })
        else { return }

        let current = canvasService.layout.workspaces[wsIdx].columns[colIdx].preferredWidth ?? 400
        let newWidth = max(250, min(800, current + Double(delta)))
        canvasService.layout.workspaces[wsIdx].columns[colIdx].preferredWidth = newWidth
    }

    private func resizeItem(_ itemID: UUID, delta: CGFloat, columnID: UUID, in workspace: CanvasWorkspace) {
        guard abs(delta) > 0.5 else { return }
        guard let wsIdx = canvasService.layout.workspaces.firstIndex(where: { $0.id == workspace.id }),
              let colIdx = canvasService.layout.workspaces[wsIdx].columns.firstIndex(where: { $0.id == columnID }),
              let itemIdx = canvasService.layout.workspaces[wsIdx].columns[colIdx].items.firstIndex(where: { $0.id == itemID })
        else { return }

        let current = canvasService.layout.workspaces[wsIdx].columns[colIdx].items[itemIdx].preferredHeight ?? 200
        let newHeight = max(100, min(800, current + Double(delta)))
        canvasService.layout.workspaces[wsIdx].columns[colIdx].items[itemIdx].preferredHeight = newHeight
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
        case "add-terminal":
            addTile(.terminal(paneId: UUID().uuidString))
        case "add-browser":
            addTile(.browser(url: nil))
        case "add-dashboard":
            addTile(.dashboard)
        case "zoom-in":
            withAnimation(.spring(duration: 0.25)) {
                gestureManager.scale = min(1.5, gestureManager.scale + 0.15)
            }
        case "zoom-out":
            withAnimation(.spring(duration: 0.25)) {
                gestureManager.scale = max(0.3, gestureManager.scale - 0.15)
            }
        case "zoom-reset":
            withAnimation(.spring(duration: 0.3)) {
                gestureManager.scale = 1.0
            }
        default:
            break
        }
    }

    /// Insert a new tile as a new column to the right of the active column, then focus it.
    private func addTile(_ ref: TileRef) {
        guard let workspace,
              let wsIdx = canvasService.layout.workspaces.firstIndex(where: { $0.id == workspace.id })
        else { return }

        let item = CanvasItem(ref: ref)
        let newColumn = CanvasColumn(items: [item])

        // Insert after the active column, or append if none active
        let insertionIndex: Int
        if let activeColID = camera.activeColumnID,
           let colIdx = canvasService.layout.workspaces[wsIdx].columns.firstIndex(where: { $0.id == activeColID }) {
            insertionIndex = colIdx + 1
        } else {
            insertionIndex = canvasService.layout.workspaces[wsIdx].columns.count
        }

        withAnimation(.spring(duration: 0.35, bounce: 0.15)) {
            canvasService.layout.workspaces[wsIdx].columns.insert(newColumn, at: insertionIndex)
        }

        // Focus the new item
        camera.focusItem(item.id, in: canvasService.layout, containerSize: containerSize)
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
    nonisolated(unsafe) static var defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) {
        value = nextValue()
    }
}
