import AppKit
import SwiftUI

/// SwiftUI NSViewRepresentable bridge for GhosttyNativeView.
///
/// Simple direct embedding — the GhosttyNativeView lives in SwiftUI's view
/// hierarchy. This may cause some Metal compositing issues but ensures the
/// terminal renders at the correct position within scrollable/transformed containers.
@MainActor
struct GhosttyTerminalView: NSViewRepresentable {
    let surface: GhosttyTerminalSurface

    func makeNSView(context: Context) -> NSView {
        let container = NSView()
        container.wantsLayer = true
        return container
    }

    func updateNSView(_ container: NSView, context: Context) {
        surface.createSurfaceIfNeeded()

        let runtimeView = surface.view

        // Add the runtime view if not already a child
        if runtimeView.superview !== container {
            runtimeView.removeFromSuperview()
            runtimeView.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(runtimeView)

            NSLayoutConstraint.activate([
                runtimeView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
                runtimeView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
                runtimeView.topAnchor.constraint(equalTo: container.topAnchor),
                runtimeView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            ])

            // Make sure the surface is visible and rendering
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
    }

    static func dismantleNSView(_ container: NSView, coordinator: ()) {
        for sub in container.subviews {
            if let nativeView = sub as? GhosttyNativeView {
                if let ghosttySurface = nativeView.terminalSurface?.surface {
                    tmuxide_ghostty_surface_set_occlusion(ghosttySurface, false)
                }
            }
            sub.removeFromSuperview()
        }
    }
}
