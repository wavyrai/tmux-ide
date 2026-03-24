import AppKit
import Foundation
import os

private let logger = Logger(subsystem: "com.tmux-ide.app", category: "GhosttyTerminalSurface")

@MainActor
final class GhosttyTerminalSurface: ObservableObject {
    let sessionID: UUID
    let workingDirectory: String
    let shellPath: String
    internal var surface: ghostty_surface_t?
    let view: GhosttyNativeView

    /// When set, this command string is passed directly to Ghostty as config.command
    /// without shell escaping. Used by MirrorTerminalController for passthrough mode
    /// (e.g. "stty raw -echo 2>/dev/null; exec cat").
    var rawCommand: String?

    private(set) var callbackContext: Unmanaged<GhosttySurfaceCallbackContext>?
    private var pendingInputQueue: [PendingInputAction] = []

    private enum PendingInputAction {
        case text(String)
        case returnKey
    }

    // MARK: - Initialization

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

        // Wire the callback context back to this surface so C callbacks can find us
        callbackContext.takeUnretainedValue().surface = self
    }

    deinit {
        callbackContext?.release()
    }

    // MARK: - Surface Lifecycle

    /// Create the Ghostty surface if it hasn't been created yet. Must be called
    /// BEFORE the view is added to any layer-backed hierarchy, because Ghostty
    /// sets up a layer-hosting view by setting layer before wantsLayer.
    func createSurfaceIfNeeded() {
        guard surface == nil else {
            flushPendingTextIfReady()
            return
        }
        GhosttyAppHost.shared.createSurface(for: self)
        flushPendingTextIfReady()
    }

    /// Tear down this surface, releasing all Ghostty resources.
    /// - Parameter freeSynchronously: If true, the Ghostty surface is freed immediately
    ///   on this call stack. If false (default), freeing is deferred to the next main
    ///   queue cycle to avoid tearing down while AppKit/CALayer is mid-transaction.
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

    // MARK: - Resize

    func resizeToCurrentViewBounds() {
        guard surface != nil else { return }
        let pointSize = view.bounds.size
        let backingSize = view.convertToBacking(NSRect(origin: .zero, size: pointSize)).size
        GhosttyAppHost.shared.resizeSurface(self, pointSize: pointSize, backingSize: backingSize)
    }

    // MARK: - Focus

    func focus() {
        guard surface != nil else { return }
        GhosttyAppHost.shared.focusSurface(self)
    }

    func blur() {
        guard surface != nil else { return }
        GhosttyAppHost.shared.blurSurface(self)
    }

    // MARK: - Input

    /// Send text to the terminal surface. If the surface hasn't been created yet,
    /// the text is queued and flushed once the surface is ready.
    func send(text: String) {
        guard !text.isEmpty else { return }
        guard surface != nil else {
            pendingInputQueue.append(.text(text))
            return
        }
        GhosttyAppHost.shared.sendText(text, to: self)
    }

    /// Send a Return key press/release to the terminal surface. If the surface
    /// hasn't been created yet, the key event is queued.
    func sendReturnKey() {
        guard surface != nil else {
            pendingInputQueue.append(.returnKey)
            return
        }
        sendReturnKeyToSurface()
    }

    /// Request a surface redraw.
    func refresh() {
        guard surface != nil else { return }
        GhosttyAppHost.shared.refreshSurface(self)
    }

    // MARK: - Private Helpers

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

        // Ensure focus before sending the key event
        tmuxide_ghostty_surface_set_focus(surface, true)

        // Press
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

        // Release
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
