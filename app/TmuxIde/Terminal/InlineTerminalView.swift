import AppKit
import SwiftUI

/// Inline terminal rendering for canvas tiles.
///
/// Unlike GhosttyTerminalView (which uses a portal pattern for standalone terminals),
/// this view keeps the GhosttyNativeView inside SwiftUI's view hierarchy as a direct
/// child of an NSViewRepresentable container. This ensures the terminal respects
/// SwiftUI's clipping, frame, and scroll position — critical for canvas tiles that
/// move, resize, and scroll.
///
/// The trade-off: SwiftUI's IOSurfaceLayer compositing may cause slight rendering
/// artifacts with Ghostty's CAMetalLayer. But the terminal stays in the right place.
@MainActor
struct InlineTerminalView: NSViewRepresentable {
    @ObservedObject var surface: GhosttyTerminalSurface

    final class InlineContainerView: NSView {
        override var wantsUpdateLayer: Bool { true }

        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
            layer?.masksToBounds = true
        }

        required init?(coder: NSCoder) {
            fatalError("init(coder:) not implemented")
        }

        var onLayout: (() -> Void)?

        override func layout() {
            super.layout()
            // Resize child to fill container
            for sub in subviews {
                sub.frame = bounds
            }
            onLayout?()
        }

        override func setFrameSize(_ newSize: NSSize) {
            super.setFrameSize(newSize)
            for sub in subviews {
                sub.frame = NSRect(origin: .zero, size: newSize)
            }
            onLayout?()
        }
    }

    func makeNSView(context: Context) -> InlineContainerView {
        let container = InlineContainerView()
        return container
    }

    func updateNSView(_ container: InlineContainerView, context: Context) {
        surface.createSurfaceIfNeeded()

        let runtimeView = surface.view

        // Add if not already a child
        if runtimeView.superview !== container {
            runtimeView.removeFromSuperview()
            runtimeView.frame = container.bounds
            container.addSubview(runtimeView)

            // Make visible and kick render
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    if let ghosttySurface = surface.surface {
                        tmuxide_ghostty_surface_set_occlusion(ghosttySurface, true)
                        tmuxide_ghostty_surface_refresh(ghosttySurface)
                        GhosttyAppHost.shared.scheduleTick()
                    }
                    surface.resizeToCurrentViewBounds()
                }
            }
        }

        container.onLayout = {
            MainActor.assumeIsolated {
                surface.resizeToCurrentViewBounds()
            }
        }
    }

    static func dismantleNSView(_ container: InlineContainerView, coordinator: ()) {
        for sub in container.subviews {
            if let nativeView = sub as? GhosttyNativeView,
               let ghosttySurface = nativeView.terminalSurface?.surface {
                tmuxide_ghostty_surface_set_occlusion(ghosttySurface, false)
            }
            sub.removeFromSuperview()
        }
    }
}
