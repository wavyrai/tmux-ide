import SwiftUI
import UniformTypeIdentifiers

struct CanvasColumnView: View {
    let column: CanvasColumn
    let sessionName: String
    let baseURL: URL
    var isOverview: Bool = false
    var draggedItemID: UUID?
    var onItemResize: ((_ itemID: UUID, _ delta: CGFloat) -> Void)?
    var onDragStarted: ((_ itemID: UUID) -> Void)?
    var onDragEnded: (() -> Void)?

    init(
        column: CanvasColumn,
        sessionName: String = "",
        baseURL: URL = ConnectionTarget.localhost.baseURL,
        isOverview: Bool = false,
        draggedItemID: UUID? = nil,
        onItemResize: ((_ itemID: UUID, _ delta: CGFloat) -> Void)? = nil,
        onDragStarted: ((_ itemID: UUID) -> Void)? = nil,
        onDragEnded: (() -> Void)? = nil
    ) {
        self.column = column
        self.sessionName = sessionName
        self.baseURL = baseURL
        self.isOverview = isOverview
        self.draggedItemID = draggedItemID
        self.onItemResize = onItemResize
        self.onDragStarted = onDragStarted
        self.onDragEnded = onDragEnded
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(column.items.enumerated()), id: \.element.id) { index, item in
                if index > 0 && !isOverview {
                    // Vertical resize handle between items (disabled during overview)
                    ItemResizeHandle { delta in
                        let upperItem = column.items[index - 1]
                        onItemResize?(upperItem.id, delta)
                    }
                }

                if index > 0 && isOverview {
                    Spacer().frame(height: 12)
                }

                tileView(for: item)
            }
        }
        .frame(
            minWidth: 300,
            idealWidth: column.preferredWidth.map { CGFloat($0) } ?? 420,
            maxWidth: 760
        )
    }

    @ViewBuilder
    private func tileView(for item: CanvasItem) -> some View {
        let isDragged = draggedItemID == item.id

        CanvasTileView(item: item, sessionName: sessionName, baseURL: baseURL)
            .opacity(isDragged ? 0.4 : 1.0)
            .scaleEffect(isDragged ? 0.95 : 1.0)
            .animation(.easeOut(duration: 0.15), value: isDragged)
            .modifier(ConditionalDragModifier(
                isEnabled: isOverview,
                itemID: item.id,
                onDragStarted: onDragStarted
            ))
    }
}

// MARK: - Conditional Drag Modifier

/// Applies `.onDrag` only when `isEnabled` is true. SwiftUI's `.onDrag`
/// cannot be conditionally applied inline, so we use a ViewModifier.
private struct ConditionalDragModifier: ViewModifier {
    let isEnabled: Bool
    let itemID: UUID
    var onDragStarted: ((_ itemID: UUID) -> Void)?

    func body(content: Content) -> some View {
        if isEnabled {
            content.onDrag {
                onDragStarted?(itemID)
                return NSItemProvider(object: itemID.uuidString as NSString)
            }
        } else {
            content
        }
    }
}
