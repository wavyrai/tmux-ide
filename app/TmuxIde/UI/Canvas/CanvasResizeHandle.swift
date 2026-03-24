import SwiftUI

// MARK: - Column Resize Handle (horizontal drag between columns)

/// A draggable handle placed between two canvas columns. Dragging left/right
/// adjusts the left column's preferredWidth.
struct ColumnResizeHandle: View {
    @Environment(\.themeColors) private var themeColors

    let height: CGFloat
    let onDelta: (CGFloat) -> Void

    @State private var lastTranslation: CGFloat = 0

    var body: some View {
        Rectangle()
            .fill(Color.clear)
            .frame(width: 16, height: height)
            .overlay {
                Rectangle()
                    .fill(themeColors.divider.opacity(0.3))
                    .frame(width: 1)
            }
            .overlay {
                Capsule(style: .continuous)
                    .fill(themeColors.divider.opacity(0.95))
                    .frame(width: 3, height: max(24, min(56, height * 0.18)))
            }
            .contentShape(Rectangle())
            .onHover { hovering in
                if hovering {
                    NSCursor.resizeLeftRight.push()
                } else {
                    NSCursor.pop()
                }
            }
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        let delta = value.translation.width - lastTranslation
                        lastTranslation = value.translation.width
                        onDelta(delta)
                    }
                    .onEnded { _ in
                        lastTranslation = 0
                    }
            )
    }
}

// MARK: - Item Resize Handle (vertical drag between items in a column)

/// A draggable handle placed between two canvas items within a column.
/// Dragging up/down adjusts the upper item's preferredHeight.
struct ItemResizeHandle: View {
    @Environment(\.themeColors) private var themeColors

    let onDelta: (CGFloat) -> Void

    @State private var lastTranslation: CGFloat = 0

    var body: some View {
        Rectangle()
            .fill(Color.clear)
            .frame(height: 12)
            .frame(maxWidth: .infinity)
            .overlay {
                Capsule(style: .continuous)
                    .fill(themeColors.divider.opacity(0.95))
                    .frame(width: 44, height: 3)
            }
            .contentShape(Rectangle())
            .onHover { hovering in
                if hovering {
                    NSCursor.resizeUpDown.push()
                } else {
                    NSCursor.pop()
                }
            }
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        let delta = value.translation.height - lastTranslation
                        lastTranslation = value.translation.height
                        onDelta(delta)
                    }
                    .onEnded { _ in
                        lastTranslation = 0
                    }
            )
    }
}
