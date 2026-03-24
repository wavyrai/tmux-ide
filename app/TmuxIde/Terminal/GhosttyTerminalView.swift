import AppKit
import SwiftUI

/// SwiftUI NSViewRepresentable bridge for GhosttyNativeView.
///
/// Uses a "portal" pattern: the GhosttyNativeView is detached from SwiftUI's
/// view hierarchy and re-parented into a layer-hosting container positioned
/// above SwiftUI's contentView in the window's theme frame. This avoids
/// SwiftUI's IOSurfaceLayer compositing interfering with Ghostty's CAMetalLayer.
@MainActor
struct GhosttyTerminalView: NSViewRepresentable {
    let surface: GhosttyTerminalSurface

    @MainActor
    final class Coordinator {
        var portalInstalled = false
        var layoutConstraints: [NSLayoutConstraint] = []
        weak var attachedRuntimeView: NSView?

        /// A layer-hosting container that isolates the terminal view from SwiftUI's
        /// IOSurfaceLayer compositing. By using a separate CALayer as the hosting layer,
        /// the terminal view's CAMetalLayer is preserved.
        var portalContainer: NSView?

        func installPortal(runtimeView: NSView, placeholder: NSView) {
            if let attachedRuntimeView, attachedRuntimeView !== runtimeView {
                removePortal(runtimeView: attachedRuntimeView)
            }

            guard !portalInstalled else { return }
            guard let window = placeholder.window,
                  let contentView = window.contentView,
                  let themeFrame = contentView.superview else { return }

            portalInstalled = true

            // Add container to the themeFrame (contentView's superview), positioned
            // above contentView. This makes the terminal a sibling of SwiftUI's
            // contentView, avoiding SwiftUI's layer-backed compositing interference.
            let container = NSView(frame: .zero)
            container.wantsLayer = true
            container.translatesAutoresizingMaskIntoConstraints = false
            portalContainer = container

            themeFrame.addSubview(container, positioned: .above, relativeTo: contentView)

            runtimeView.removeFromSuperview()
            runtimeView.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(runtimeView)
            attachedRuntimeView = runtimeView

            NSLayoutConstraint.activate([
                runtimeView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
                runtimeView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
                runtimeView.topAnchor.constraint(equalTo: container.topAnchor),
                runtimeView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            ])

            updatePortalFrame(runtimeView: runtimeView, placeholder: placeholder)

            // Tell ghostty this surface is visible again and kick a render.
            // Without this, animations freeze because the surface was marked occluded
            // when removed.
            DispatchQueue.main.async {
                if let nativeView = runtimeView as? GhosttyNativeView {
                    MainActor.assumeIsolated {
                        if let surface = nativeView.terminalSurface?.surface {
                            tmuxide_ghostty_surface_set_occlusion(surface, true)
                            tmuxide_ghostty_surface_refresh(surface)
                            GhosttyAppHost.shared.scheduleTick()
                        }
                    }
                }
            }
        }

        func updatePortalFrame(runtimeView: NSView, placeholder: NSView) {
            guard let window = placeholder.window,
                  let contentView = window.contentView,
                  let container = portalContainer else { return }

            NSLayoutConstraint.deactivate(layoutConstraints)
            layoutConstraints.removeAll()

            // Position the container to match the placeholder's location.
            // Container is a sibling of contentView in the themeFrame, so
            // we constrain relative to contentView's anchors.
            let frame = placeholder.convert(placeholder.bounds, to: contentView)

            layoutConstraints = [
                container.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: frame.origin.x),
                container.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: frame.origin.y),
                container.widthAnchor.constraint(equalToConstant: frame.width),
                container.heightAnchor.constraint(equalToConstant: frame.height),
            ]
            NSLayoutConstraint.activate(layoutConstraints)
        }

        func removePortal(runtimeView: NSView?) {
            guard portalInstalled else { return }
            NSLayoutConstraint.deactivate(layoutConstraints)
            layoutConstraints.removeAll()

            let view = runtimeView ?? attachedRuntimeView

            // Only remove the runtimeView if it's still inside THIS coordinator's
            // portal container. Another coordinator may have already re-parented it
            // (e.g. during a canvas restructure where dismantleNSView fires after
            // the replacement view's installPortal).
            let stillOurs = view?.superview === portalContainer

            if stillOurs {
                // Tell ghostty this surface is no longer visible so it can pause rendering
                if let nativeView = view as? GhosttyNativeView {
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated {
                            if let surface = nativeView.terminalSurface?.surface {
                                tmuxide_ghostty_surface_set_occlusion(surface, false)
                            }
                        }
                    }
                }
                view?.removeFromSuperview()
            }

            portalContainer?.removeFromSuperview()
            portalContainer = nil
            attachedRuntimeView = nil
            portalInstalled = false
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> PortalPlaceholderView {
        let view = PortalPlaceholderView()
        view.wantsLayer = false
        return view
    }

    func updateNSView(_ nsView: PortalPlaceholderView, context: Context) {
        surface.createSurfaceIfNeeded()

        let runtimeView = surface.view
        let coordinator = context.coordinator

        nsView.onLayout = { [weak nsView] in
            guard let nsView else { return }
            coordinator.updatePortalFrame(runtimeView: runtimeView, placeholder: nsView)
            surface.resizeToCurrentViewBounds()
        }

        nsView.onWindowChanged = { [weak nsView] in
            guard let nsView else { return }
            if nsView.window != nil {
                coordinator.installPortal(runtimeView: runtimeView, placeholder: nsView)
            } else {
                coordinator.removePortal(runtimeView: runtimeView)
            }
        }

        if nsView.window != nil, !coordinator.portalInstalled {
            coordinator.installPortal(runtimeView: runtimeView, placeholder: nsView)
        } else if coordinator.attachedRuntimeView !== runtimeView {
            coordinator.installPortal(runtimeView: runtimeView, placeholder: nsView)
        } else if coordinator.portalInstalled {
            coordinator.updatePortalFrame(runtimeView: runtimeView, placeholder: nsView)
        }
    }

    @MainActor
    static func dismantleNSView(_ nsView: PortalPlaceholderView, coordinator: Coordinator) {
        coordinator.removePortal(runtimeView: coordinator.attachedRuntimeView)
    }
}

/// Placeholder view that tracks geometry changes and window attachment.
/// Lives in SwiftUI's view tree and reports its frame so the portal container
/// (which lives outside SwiftUI) can be positioned to match.
final class PortalPlaceholderView: NSView {
    var onLayout: (() -> Void)?
    var onWindowChanged: (() -> Void)?

    override func layout() {
        super.layout()
        onLayout?()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        onWindowChanged?()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        onLayout?()
    }
}
