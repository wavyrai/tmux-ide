// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel
import AppKit
import Foundation
import os.log

private let logger = Logger(subsystem: BundleIdentifiers.loggerSubsystem, category: "StatusBarIconController")

/// Manages the visual appearance of the status bar item's button.
///
/// This class is responsible for updating the icon and title of the status bar button
/// based on the application's state, such as server status and active sessions.
@MainActor
final class StatusBarIconController {
    private weak var button: NSStatusBarButton?

    /// Initializes the icon controller with the status bar button.
    /// - Parameter button: The `NSStatusBarButton` to manage.
    init(button: NSStatusBarButton?) {
        self.button = button
    }

    /// Updates the entire visual state of the status bar button.
    ///
    /// - Parameters:
    ///   - serverManager: The manager for the TmuxIde server.
    ///   - sessionMonitor: The monitor for active terminal sessions.
    func update(serverManager: ServerManager, sessionMonitor: SessionMonitor) {
        guard let button else { return }

        self.updateIcon(
            isServerRunning: serverManager.isRunning,
            hasBusyAgents: sessionMonitor.hasBusyAgents)

        // Update session count display
        let sessions = sessionMonitor.sessions.values.filter(\.isRunning)
        let activeSessions = sessions.filter(\.isActivityActive)

        let activeCount = activeSessions.count
        let totalCount = sessions.count
        let idleCount = totalCount - activeCount

        let indicator = self.formatSessionIndicator(activeCount: activeCount, idleCount: idleCount)
        button.title = indicator.isEmpty ? "" : " " + indicator
    }

    /// Updates the icon of the status bar button based on the server's running state
    /// and whether any agent panes are busy (pulse + accent).
    private func updateIcon(isServerRunning: Bool, hasBusyAgents: Bool) {
        guard let button else { return }

        guard let image = NSImage(named: "menubar") else {
            logger.warning("menubar icon not found")
            return
        }

        image.isTemplate = true
        button.image = image

        if !isServerRunning {
            button.alphaValue = 0.45
            button.contentTintColor = nil
            return
        }

        if hasBusyAgents {
            let t = Date.timeIntervalSinceReferenceDate
            // Smooth pulse while agents are working.
            let pulse = 0.72 + 0.28 * (0.5 + 0.5 * sin(t * 2.8))
            button.alphaValue = CGFloat(pulse)
            button.contentTintColor = .controlAccentColor
        } else {
            button.alphaValue = 1.0
            button.contentTintColor = nil
        }
    }

    /// Formats the session count indicator with a minimalist style.
    private func formatSessionIndicator(activeCount: Int, idleCount: Int) -> String {
        let totalCount = activeCount + idleCount
        guard totalCount > 0 else { return "" }

        if activeCount == 0 {
            return String(totalCount)
        } else if activeCount == totalCount {
            return "● \(activeCount)"
        } else {
            return "\(activeCount) | \(idleCount)"
        }
    }
}
