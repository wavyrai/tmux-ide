import SwiftUI

/// A subtle dot-grid background that parallax-scrolls with the canvas offset,
/// giving the infinite-workspace spatial feel.
struct DotGridBackground: View {
    @Environment(\.themeColors) private var themeColors

    let offsetX: CGFloat
    let offsetY: CGFloat

    private let dotSpacing: CGFloat = 24
    private let dotRadius: CGFloat = 1.0

    var body: some View {
        Canvas { context, size in
            let dotColor = themeColors.divider.opacity(0.7)

            // Compute phase so dots scroll with the canvas
            let phaseX = offsetX.truncatingRemainder(dividingBy: dotSpacing)
            let phaseY = offsetY.truncatingRemainder(dividingBy: dotSpacing)

            let startX = phaseX - dotSpacing
            let startY = phaseY - dotSpacing
            let cols = Int(size.width / dotSpacing) + 3
            let rows = Int(size.height / dotSpacing) + 3

            for row in 0..<rows {
                for col in 0..<cols {
                    let x = startX + CGFloat(col) * dotSpacing
                    let y = startY + CGFloat(row) * dotSpacing
                    let rect = CGRect(
                        x: x - dotRadius,
                        y: y - dotRadius,
                        width: dotRadius * 2,
                        height: dotRadius * 2
                    )
                    context.fill(Circle().path(in: rect), with: .color(dotColor))
                }
            }
        }
        .background(themeColors.surface0)
        .drawingGroup()
    }
}
