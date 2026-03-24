import AppKit

// MARK: - Shortcut Dispatcher

/// Installs an NSEvent local monitor to intercept key events and dispatch
/// matching shortcuts to a handler. The monitor runs app-wide, so shortcuts
/// work regardless of which view has focus.
@MainActor
final class ShortcutDispatcher {
    let registry: ShortcutRegistry
    private var monitor: Any?
    private var actionHandler: ((String) -> Void)?

    init(registry: ShortcutRegistry, handler: @escaping (String) -> Void) {
        self.registry = registry
        self.actionHandler = handler
    }

    /// Start intercepting key events. Call once at app launch.
    func start() {
        guard monitor == nil else { return }
        let registry = self.registry
        // Capture handler ref to avoid capturing self in the non-Sendable closure.
        let handler = self.actionHandler
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if let entry = registry.match(event) {
                DispatchQueue.main.async {
                    handler?(entry.id)
                }
                return nil // consume the event
            }
            return event // pass through
        }
    }

    /// Stop intercepting key events.
    func stop() {
        if let monitor {
            NSEvent.removeMonitor(monitor)
        }
        monitor = nil
    }

    deinit {
        if let monitor {
            NSEvent.removeMonitor(monitor)
        }
    }
}
