import Foundation
import SwiftUI

// MARK: - Canvas Metrics

/// Layout metrics for the canvas tile system.
/// Adapted from IDX0's NiriCanvasMetrics pattern, tailored to tmux-ide's
/// workspace > column > item hierarchy.
struct CanvasMetrics: Equatable {
    var tileWidth: CGFloat
    var tileHeight: CGFloat
    var columnSpacing: CGFloat
    var itemSpacing: CGFloat
    var headerHeight: CGFloat
    var originX: CGFloat
    var originY: CGFloat
    var containerWidth: CGFloat
    var containerHeight: CGFloat
    var canvasScale: CGFloat

    // MARK: - Constants

    static let minTileWidth: CGFloat = 300
    static let maxTileWidth: CGFloat = 760
    static let minTileHeight: CGFloat = 200
    static let maxTileHeight: CGFloat = 520
    static let defaultColumnSpacing: CGFloat = 16
    static let defaultItemSpacing: CGFloat = 12
    static let defaultHeaderHeight: CGFloat = 20
    static let overviewScale: CGFloat = 0.55
    static let focusedScale: CGFloat = 1.0

    // MARK: - Factory

    /// Compute metrics from container size and overview state.
    static func compute(containerSize: CGSize, isOverview: Bool) -> CanvasMetrics {
        let scale: CGFloat = isOverview ? overviewScale : focusedScale
        let width = max(minTileWidth, min(containerSize.width * 0.72, maxTileWidth)) * scale
        let height = max(minTileHeight, min(containerSize.height * 0.62, maxTileHeight)) * scale
        return CanvasMetrics(
            tileWidth: width,
            tileHeight: height,
            columnSpacing: defaultColumnSpacing * scale,
            itemSpacing: defaultItemSpacing * scale,
            headerHeight: defaultHeaderHeight,
            originX: max(20, containerSize.width * 0.5 - width * 0.5),
            originY: max(18, containerSize.height * 0.5 - height * 0.5),
            containerWidth: containerSize.width,
            containerHeight: containerSize.height,
            canvasScale: scale
        )
    }

    // MARK: - Column sizing

    var columnMinWidth: CGFloat {
        max(260, tileWidth * 0.45)
    }

    var columnMaxWidth: CGFloat {
        max(columnMinWidth + 80, tileWidth * 2.4)
    }

    func columnWidth(for column: CanvasColumn) -> CGFloat {
        let preferred = column.preferredWidth.map { CGFloat($0) * canvasScale }
        return max(columnMinWidth, min(columnMaxWidth, preferred ?? tileWidth))
    }

    // MARK: - Item sizing

    var itemMinHeight: CGFloat {
        max(120, tileHeight * 0.32)
    }

    var itemMaxHeight: CGFloat {
        max(itemMinHeight + 120, tileHeight * 4.8)
    }

    func itemHeight(for item: CanvasItem?) -> CGFloat {
        guard let preferred = item?.preferredHeight else {
            return max(itemMinHeight, min(itemMaxHeight, tileHeight))
        }
        return max(itemMinHeight, min(itemMaxHeight, CGFloat(preferred) * canvasScale))
    }

    // MARK: - Column content height

    func columnContentHeight(for column: CanvasColumn) -> CGFloat {
        guard !column.items.isEmpty else { return tileHeight }
        let itemsHeight = column.items.reduce(CGFloat.zero) { partial, item in
            partial + itemHeight(for: item)
        }
        let spacing = CGFloat(max(column.items.count - 1, 0)) * itemSpacing
        return itemsHeight + spacing
    }

    // MARK: - Workspace height

    func workspaceHeight(for workspace: CanvasWorkspace) -> CGFloat {
        guard !workspace.columns.isEmpty else {
            return headerHeight + tileHeight * 0.55 + 8
        }
        let tallestColumn = workspace.columns.map { columnContentHeight(for: $0) }.max() ?? tileHeight
        return headerHeight + tallestColumn + 8
    }

    // MARK: - Camera offset calculations

    /// Horizontal offset needed to center the given column index within the workspace.
    func leadingOffset(for workspace: CanvasWorkspace, anchorColumnIndex: Int) -> CGFloat {
        guard !workspace.columns.isEmpty else { return 0 }
        let clamped = min(max(anchorColumnIndex, 0), workspace.columns.count - 1)
        var offset: CGFloat = 0
        for index in 0..<clamped {
            offset += columnWidth(for: workspace.columns[index])
            offset += columnSpacing
        }
        let anchorWidth = columnWidth(for: workspace.columns[clamped])
        let centeringAdjustment = (containerWidth - anchorWidth) / 2
        return offset - centeringAdjustment
    }

    /// Vertical offset needed to center the given item within a column.
    func verticalOffset(for column: CanvasColumn, focusedItemIndex: Int) -> CGFloat {
        guard !column.items.isEmpty else { return 0 }
        let clamped = min(max(focusedItemIndex, 0), column.items.count - 1)
        var offset: CGFloat = 0
        for index in 0..<clamped {
            offset += itemHeight(for: column.items[index])
            offset += itemSpacing
        }
        let focusedHeight = itemHeight(for: column.items[clamped])
        let centeringAdjustment = (containerHeight - focusedHeight) / 2
        return offset - centeringAdjustment
    }
}

// MARK: - Camera State Manager

/// Observable camera controller that manages pan offset, focus state,
/// and smooth spring animations between canvas positions.
@MainActor
final class CameraStateManager: ObservableObject {
    // MARK: - Published state

    /// Current pan offset (the camera's top-left position in canvas coordinates).
    @Published var panOffset: CGPoint = .zero

    /// Whether overview mode is active (zoomed out to see all tiles).
    @Published var isOverview: Bool = false

    /// The ID of the active workspace.
    @Published var activeWorkspaceID: UUID?

    /// The ID of the active column within the workspace.
    @Published var activeColumnID: UUID?

    /// The ID of the focused item within the active column.
    @Published var focusedItemID: UUID?

    // MARK: - Animation

    static let cameraSpring = Animation.spring(response: 0.4, dampingFraction: 0.85)

    // MARK: - Sync with layout

    /// Synchronize published state from a `CameraState` value (e.g. from CanvasLayout).
    func sync(from state: CameraState) {
        activeWorkspaceID = state.activeWorkspaceID
        activeColumnID = state.activeColumnID
        focusedItemID = state.focusedItemID
    }

    /// Export current focus state as a `CameraState` value.
    var cameraState: CameraState {
        CameraState(
            activeWorkspaceID: activeWorkspaceID,
            activeColumnID: activeColumnID,
            focusedItemID: focusedItemID
        )
    }

    // MARK: - Focus actions

    /// Focus a specific item, animating the camera to center it.
    func focusItem(
        _ itemID: UUID,
        in layout: CanvasLayout,
        containerSize: CGSize
    ) {
        guard let (workspace, colIndex, itemIndex) = resolveItem(itemID, in: layout) else { return }
        let column = workspace.columns[colIndex]

        activeWorkspaceID = workspace.id
        activeColumnID = column.id
        focusedItemID = itemID
        isOverview = false

        let metrics = CanvasMetrics.compute(containerSize: containerSize, isOverview: false)
        let targetX = metrics.leadingOffset(for: workspace, anchorColumnIndex: colIndex)
        let targetY = metrics.verticalOffset(for: column, focusedItemIndex: itemIndex)

        withAnimation(Self.cameraSpring) {
            panOffset = CGPoint(x: targetX, y: targetY)
        }
    }

    /// Focus a column (first item), animating the camera to center it.
    func focusColumn(
        _ columnID: UUID,
        in layout: CanvasLayout,
        containerSize: CGSize
    ) {
        guard let (workspace, colIndex) = resolveColumn(columnID, in: layout) else { return }
        let column = workspace.columns[colIndex]
        let firstItemID = column.items.first?.id

        activeWorkspaceID = workspace.id
        activeColumnID = columnID
        focusedItemID = firstItemID
        isOverview = false

        let metrics = CanvasMetrics.compute(containerSize: containerSize, isOverview: false)
        let targetX = metrics.leadingOffset(for: workspace, anchorColumnIndex: colIndex)
        let targetY: CGFloat = 0

        withAnimation(Self.cameraSpring) {
            panOffset = CGPoint(x: targetX, y: targetY)
        }
    }

    /// Toggle between overview (0.55 scale) and focused (1.0 scale) modes.
    func toggleOverview(layout: CanvasLayout, containerSize: CGSize) {
        isOverview.toggle()

        if isOverview {
            // In overview, reset pan to show all content from the top-left
            withAnimation(Self.cameraSpring) {
                panOffset = .zero
            }
        } else if let columnID = activeColumnID {
            // Return to focused mode on the active column
            focusColumn(columnID, in: layout, containerSize: containerSize)
        }
    }

    // MARK: - Arrow key navigation

    func navigateLeft(in layout: CanvasLayout, containerSize: CGSize) {
        guard let (workspace, colIndex) = activeColumn(in: layout), colIndex > 0 else { return }
        let targetColumn = workspace.columns[colIndex - 1]
        focusColumn(targetColumn.id, in: layout, containerSize: containerSize)
    }

    func navigateRight(in layout: CanvasLayout, containerSize: CGSize) {
        guard let (workspace, colIndex) = activeColumn(in: layout),
              colIndex < workspace.columns.count - 1 else { return }
        let targetColumn = workspace.columns[colIndex + 1]
        focusColumn(targetColumn.id, in: layout, containerSize: containerSize)
    }

    func navigateUp(in layout: CanvasLayout, containerSize: CGSize) {
        guard let (workspace, colIndex) = activeColumn(in: layout) else { return }
        let column = workspace.columns[colIndex]
        guard let currentIndex = focusedItemIndex(in: column), currentIndex > 0 else { return }
        let targetItem = column.items[currentIndex - 1]
        focusItem(targetItem.id, in: layout, containerSize: containerSize)
    }

    func navigateDown(in layout: CanvasLayout, containerSize: CGSize) {
        guard let (workspace, colIndex) = activeColumn(in: layout) else { return }
        let column = workspace.columns[colIndex]
        guard let currentIndex = focusedItemIndex(in: column),
              currentIndex < column.items.count - 1 else { return }
        let targetItem = column.items[currentIndex + 1]
        focusItem(targetItem.id, in: layout, containerSize: containerSize)
    }

    // MARK: - Resolution helpers

    private func activeColumn(in layout: CanvasLayout) -> (CanvasWorkspace, Int)? {
        guard let columnID = activeColumnID else { return nil }
        return resolveColumn(columnID, in: layout)
    }

    private func focusedItemIndex(in column: CanvasColumn) -> Int? {
        guard let itemID = focusedItemID else {
            return column.items.isEmpty ? nil : 0
        }
        return column.items.firstIndex { $0.id == itemID }
    }

    private func resolveColumn(_ columnID: UUID, in layout: CanvasLayout) -> (CanvasWorkspace, Int)? {
        for workspace in layout.workspaces {
            if let index = workspace.columns.firstIndex(where: { $0.id == columnID }) {
                return (workspace, index)
            }
        }
        return nil
    }

    private func resolveItem(_ itemID: UUID, in layout: CanvasLayout) -> (CanvasWorkspace, Int, Int)? {
        for workspace in layout.workspaces {
            for (colIndex, column) in workspace.columns.enumerated() {
                if let itemIndex = column.items.firstIndex(where: { $0.id == itemID }) {
                    return (workspace, colIndex, itemIndex)
                }
            }
        }
        return nil
    }
}
