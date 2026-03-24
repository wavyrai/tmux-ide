import AppKit
import Foundation

@MainActor
final class GhosttyTerminalSurface: ObservableObject {
    let sessionID: UUID
    let workingDirectory: String
    let shellPath: String
    internal var surface: ghostty_surface_t?
    let view: GhosttyNativeView

    /// When set, this command string is passed directly to Ghostty as config.command
    /// without shell escaping. Used by MirrorTerminalController for passthrough mode.
    var rawCommand: String?

    private(set) var callbackContext: Unmanaged<GhosttySurfaceCallbackContext>?
    private var pendingInputQueue: [PendingInputAction] = []

    private enum PendingInputAction {
        case text(String)
        case returnKey
    }

    init(
        sessionID: UUID,
        workingDirectory: String,
        shellPath: String,
        view: GhosttyNativeView,
        callbackContext: Unmanaged<GhosttySurfaceCallbackContext>
    ) {
        self.sessionID = sessionID
        self.workingDirectory = workingDirectory
        self.shellPath = shellPath
        self.view = view
        self.callbackContext = callbackContext

        callbackContext.takeUnretainedValue().surface = self
    }

    deinit {
        callbackContext?.release()
    }

    /// Create the ghostty surface. Must be called BEFORE the view is added
    /// to any layer-backed hierarchy, because ghostty sets up a layer-hosting
    /// view by setting layer before wantsLayer.
    func createSurfaceIfNeeded() {
        guard surface == nil else {
            flushPendingTextIfReady()
            return
        }
        GhosttyAppHost.shared.createSurface(for: self)
        flushPendingTextIfReady()
    }

    func destroy(freeSynchronously: Bool = false) {
        let context = callbackContext
        callbackContext = nil
        context?.takeUnretainedValue().surface = nil

        guard let surfaceToFree = surface else {
            view.prepareForSurfaceTeardown()
            context?.release()
            return
        }

        GhosttyAppHost.shared.removeSurface(self)
        surface = nil

        tmuxide_ghostty_surface_set_focus(surfaceToFree, false)
        tmuxide_ghostty_surface_set_occlusion(surfaceToFree, false)
        view.prepareForSurfaceTeardown()

        if freeSynchronously {
            tmuxide_ghostty_surface_free(surfaceToFree)
            context?.release()
            return
        }

        // Keep free asynchronous to avoid tearing down while AppKit/CALayer is
        // still in the same render transaction for this view.
        Task { @MainActor in
            tmuxide_ghostty_surface_free(surfaceToFree)
            context?.release()
        }
    }

    func resizeToCurrentViewBounds() {
        guard surface != nil else { return }
        let pointSize = view.bounds.size
        let backingSize = view.convertToBacking(NSRect(origin: .zero, size: pointSize)).size
        GhosttyAppHost.shared.resizeSurface(self, pointSize: pointSize, backingSize: backingSize)
    }

    func focus() {
        guard surface != nil else { return }
        GhosttyAppHost.shared.focusSurface(self)
    }

    func blur() {
        guard surface != nil else { return }
        GhosttyAppHost.shared.blurSurface(self)
    }

    func send(text: String) {
        guard !text.isEmpty else { return }
        guard surface != nil else {
            pendingInputQueue.append(.text(text))
            return
        }
        GhosttyAppHost.shared.sendText(text, to: self)
    }

    func sendReturnKey() {
        guard surface != nil else {
            pendingInputQueue.append(.returnKey)
            return
        }
        sendReturnKeyToSurface()
    }

    func refresh() {
        guard surface != nil else { return }
        GhosttyAppHost.shared.refreshSurface(self)
    }

    private func flushPendingTextIfReady() {
        guard surface != nil, !pendingInputQueue.isEmpty else { return }
        let queued = pendingInputQueue
        pendingInputQueue.removeAll(keepingCapacity: true)
        for action in queued {
            switch action {
            case .text(let text):
                GhosttyAppHost.shared.sendText(text, to: self)
            case .returnKey:
                sendReturnKeyToSurface()
            }
        }
    }

    private func sendReturnKeyToSurface() {
        guard let surface else { return }
        tmuxide_ghostty_surface_set_focus(surface, true)
        var press = ghostty_input_key_s()
        press.action = GHOSTTY_ACTION_PRESS
        press.keycode = 36 // Return key virtual key code on macOS
        press.mods = GHOSTTY_MODS_NONE
        press.consumed_mods = GHOSTTY_MODS_NONE
        press.composing = false
        press.unshifted_codepoint = 13
        "\r".withCString { ptr in
            press.text = ptr
            _ = tmuxide_ghostty_surface_key(surface, press)
        }

        var release = ghostty_input_key_s()
        release.action = GHOSTTY_ACTION_RELEASE
        release.keycode = 36
        release.mods = GHOSTTY_MODS_NONE
        release.consumed_mods = GHOSTTY_MODS_NONE
        release.text = nil
        release.composing = false
        release.unshifted_codepoint = 0
        _ = tmuxide_ghostty_surface_key(surface, release)
        GhosttyAppHost.shared.scheduleTick()
    }
}
