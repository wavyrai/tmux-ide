import AppKit
import Foundation
import os

private let logger = Logger(subsystem: "com.tmux-ide.app", category: "GhosttyAppHost")

@MainActor
final class GhosttyAppHost {
    enum Availability: Equatable {
        case available(String)
        case unavailable(String)

        var isAvailable: Bool {
            if case .available = self {
                return true
            }
            return false
        }
    }

    static let shared = GhosttyAppHost()

    private(set) var availability: Availability = .unavailable("libghostty has not been initialized")
    private(set) var app: ghostty_app_t?
    private(set) var config: ghostty_config_t?

    // MARK: - Surface Event Callbacks

    /// Called when a surface's title changes (e.g. shell sets window title).
    var onSurfaceTitle: ((UUID, String) -> Void)?
    /// Called when a surface's working directory changes.
    var onSurfaceCwd: ((UUID, String) -> Void)?
    /// Called when a surface requests attention (notification, command finished, etc.).
    var onSurfaceAttention: ((UUID) -> Void)?
    /// Called when a surface closes (shell exits, etc.).
    var onSurfaceClose: ((UUID) -> Void)?
    /// Called when a surface wants to open a URL.
    var onOpenURL: ((UUID, URL) -> Void)?

    // MARK: - Private State

    private var surfaceByKey: [UInt: GhosttyTerminalSurface] = [:]
    private var needsTick = false
    private var tickEnqueued = false
    private var appObservers: [NSObjectProtocol] = []

    private static let shellSafeCommandCharacters = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_@%+=:,./-"
    )

    // MARK: - Initialization

    private init() {
        initialize()
    }

    func initialize() {
        guard app == nil else { return }

        // Load the dynamic Ghostty library
        var maybeError: UnsafePointer<CChar>?
        guard tmuxide_ghostty_load(&maybeError) else {
            let message = maybeError.map { String(cString: $0) } ?? "Unable to load libghostty"
            availability = .unavailable(message)
            logger.warning("Ghostty unavailable: \(message)")
            return
        }

        let loadPath = tmuxide_ghostty_loaded_path().map { String(cString: $0) } ?? "dynamic"
        let initResult = tmuxide_ghostty_init(UInt(CommandLine.argc), CommandLine.unsafeArgv)
        guard initResult == GHOSTTY_SUCCESS else {
            availability = .unavailable("ghostty_init failed: \(initResult)")
            logger.error("ghostty_init failed with code \(initResult.rawValue)")
            return
        }

        // Create default Ghostty config
        guard let config = tmuxide_ghostty_config_new() else {
            availability = .unavailable("ghostty_config_new failed")
            return
        }

        tmuxide_ghostty_config_load_default_files(config)
        tmuxide_ghostty_config_finalize(config)

        // Set up runtime callbacks that Ghostty uses to communicate with us
        var runtimeConfig = ghostty_runtime_config_s()
        runtimeConfig.userdata = Unmanaged.passUnretained(self).toOpaque()
        runtimeConfig.supports_selection_clipboard = true

        runtimeConfig.wakeup_cb = { userdata in
            guard let userdata else { return }
            let host = Unmanaged<GhosttyAppHost>.fromOpaque(userdata).takeUnretainedValue()
            Task { @MainActor in
                host.scheduleTick()
            }
        }

        runtimeConfig.action_cb = { app, target, action in
            _ = app
            return GhosttyAppHost.handleRuntimeAction(target: target, action: action)
        }

        runtimeConfig.read_clipboard_cb = { userdata, _, state in
            guard let userdata else { return }
            let context = Unmanaged<GhosttySurfaceCallbackContext>.fromOpaque(userdata).takeUnretainedValue()
            guard let surface = context.surface?.surface else { return }
            let value = NSPasteboard.general.string(forType: .string) ?? ""
            value.withCString { cString in
                tmuxide_ghostty_surface_complete_clipboard_request(surface, cString, state, false)
            }
        }

        runtimeConfig.confirm_read_clipboard_cb = { userdata, content, state, _ in
            guard let userdata else { return }
            let context = Unmanaged<GhosttySurfaceCallbackContext>.fromOpaque(userdata).takeUnretainedValue()
            guard let surface = context.surface?.surface else { return }
            tmuxide_ghostty_surface_complete_clipboard_request(surface, content, state, true)
        }

        runtimeConfig.write_clipboard_cb = { _, _, content, len, _ in
            guard let content, len > 0 else { return }
            let first = content[0]
            guard let data = first.data else { return }
            let text = String(cString: data)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }

        runtimeConfig.close_surface_cb = { userdata, _ in
            guard let userdata else { return }
            let context = Unmanaged<GhosttySurfaceCallbackContext>.fromOpaque(userdata).takeUnretainedValue()
            Task { @MainActor in
                context.host?.onSurfaceClose?(context.sessionID)
            }
        }

        // Create the Ghostty app instance
        guard let app = tmuxide_ghostty_app_new(&runtimeConfig, config) else {
            availability = .unavailable("ghostty_app_new failed")
            tmuxide_ghostty_config_free(config)
            return
        }

        self.config = config
        self.app = app
        self.availability = .available(loadPath)
        synchronizeAppFocusObservers()
        logger.info("Ghostty loaded from: \(loadPath)")
    }

    // MARK: - Shutdown

    func shutdown(freeSurfacesSynchronously: Bool = false) {
        let surfaces = Array(surfaceByKey.values)
        surfaces.forEach { $0.destroy(freeSynchronously: freeSurfacesSynchronously) }
        surfaceByKey.removeAll()

        for observer in appObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        appObservers.removeAll()

        if let app {
            tmuxide_ghostty_app_free(app)
            self.app = nil
        }

        if let config {
            tmuxide_ghostty_config_free(config)
            self.config = nil
        }
    }

    /// Tear down and reinitialize Ghostty.
    /// Returns true if reinitialization succeeded.
    @discardableResult
    func reinitialize() -> Bool {
        shutdown()
        initialize()
        return app != nil
    }

    // MARK: - Surface Lifecycle

    /// Create a new terminal surface wrapper. The actual Ghostty surface is created
    /// lazily when the view is added to a window (see `createSurface(for:)`).
    func makeSurface(sessionID: UUID, workingDirectory: String, shellPath: String) -> GhosttyTerminalSurface? {
        guard app != nil else { return nil }

        let view = GhosttyNativeView(frame: NSRect(x: 0, y: 0, width: 900, height: 620))
        let callbackContext = Unmanaged.passRetained(GhosttySurfaceCallbackContext(host: self, sessionID: sessionID))

        let wrapper = GhosttyTerminalSurface(
            sessionID: sessionID,
            workingDirectory: workingDirectory,
            shellPath: shellPath,
            view: view,
            callbackContext: callbackContext
        )
        view.terminalSurface = wrapper

        // Surface creation is deferred until the view is in a window.
        // Ghostty needs the view to have a proper window/screen for
        // display ID, backing scale, and Metal renderer setup.

        return wrapper
    }

    /// Create the actual Ghostty surface. Must be called BEFORE the view enters
    /// any layer-backed hierarchy so Ghostty can set up layer-hosting mode.
    func createSurface(for wrapper: GhosttyTerminalSurface) {
        guard let app else { return }
        guard wrapper.surface == nil else { return }

        let view = wrapper.view

        var config = tmuxide_ghostty_surface_config_new()
        config.platform_tag = GHOSTTY_PLATFORM_MACOS
        config.platform = ghostty_platform_u(macos: ghostty_platform_macos_s(nsview: Unmanaged.passUnretained(view).toOpaque()))
        if let ctx = wrapper.callbackContext {
            config.userdata = ctx.toOpaque()
        }

        let scaleFactor = view.window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        config.scale_factor = max(1, Double(scaleFactor))

        let command = wrapper.shellPath.isEmpty ? nil : Self.shellEscapedCommand(wrapper.shellPath)
        let surface: ghostty_surface_t? = wrapper.workingDirectory.withCString { cwdCString in
            if let command {
                return command.withCString { shellCString in
                    config.working_directory = cwdCString
                    config.command = shellCString
                    return tmuxide_ghostty_surface_new(app, &config)
                }
            } else {
                config.working_directory = cwdCString
                config.command = nil
                return tmuxide_ghostty_surface_new(app, &config)
            }
        }

        guard let surface else {
            logger.error("Failed to create Ghostty surface for session \(wrapper.sessionID)")
            return
        }

        wrapper.surface = surface

        let key = UInt(bitPattern: Int(bitPattern: surface))
        surfaceByKey[key] = wrapper

        // Set display ID for vsync-driven rendering (use primary screen if not in window yet)
        if let screen = view.window?.screen ?? NSScreen.main,
           let displayID = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
            tmuxide_ghostty_surface_set_display_id(surface, displayID.uint32Value)
        }

        // Set scale and size using pixel (backing) dimensions.
        // If the view isn't in a window yet, convertToBacking won't have the right
        // scale, so use the screen's backing scale factor directly.
        let backingSize: CGSize
        if view.window != nil {
            backingSize = view.convertToBacking(NSRect(origin: .zero, size: view.bounds.size)).size
        } else {
            let scale = NSScreen.main?.backingScaleFactor ?? 2
            backingSize = CGSize(width: view.bounds.width * scale, height: view.bounds.height * scale)
        }
        let xScale = backingSize.width / max(1, view.bounds.width)
        let yScale = backingSize.height / max(1, view.bounds.height)
        tmuxide_ghostty_surface_set_content_scale(surface, xScale, yScale)
        let wpx = UInt32(max(1, Int(floor(backingSize.width))))
        let hpx = UInt32(max(1, Int(floor(backingSize.height))))
        tmuxide_ghostty_surface_set_size(surface, wpx, hpx)

        // Tell Ghostty the surface is visible so the renderer starts drawing
        tmuxide_ghostty_surface_set_occlusion(surface, true)

        // Kick initial draw
        tmuxide_ghostty_surface_refresh(surface)
        scheduleTick()
    }

    static func shellEscapedCommand(_ command: String) -> String {
        guard !command.isEmpty else { return command }
        if command.rangeOfCharacter(from: shellSafeCommandCharacters.inverted) == nil {
            return command
        }
        return "'\(command.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
    }

    func removeSurface(_ wrapper: GhosttyTerminalSurface) {
        guard let surface = wrapper.surface else { return }
        let key = UInt(bitPattern: Int(bitPattern: surface))
        surfaceByKey.removeValue(forKey: key)
    }

    // MARK: - Surface Focus

    func focusSurface(_ wrapper: GhosttyTerminalSurface) {
        guard let surface = wrapper.surface else { return }
        setAppFocus(true)
        tmuxide_ghostty_surface_set_focus(surface, true)
        if wrapper.view.window?.firstResponder !== wrapper.view {
            wrapper.view.window?.makeFirstResponder(wrapper.view)
        }
        scheduleTick()
    }

    func blurSurface(_ wrapper: GhosttyTerminalSurface) {
        guard let surface = wrapper.surface else { return }
        tmuxide_ghostty_surface_set_focus(surface, false)
        scheduleTick()
    }

    // MARK: - Surface Resize

    func resizeSurface(_ wrapper: GhosttyTerminalSurface, pointSize: CGSize, backingSize: CGSize) {
        guard let surface = wrapper.surface else { return }
        guard backingSize.width > 0, backingSize.height > 0 else { return }
        let xScale = backingSize.width / pointSize.width
        let yScale = backingSize.height / pointSize.height
        tmuxide_ghostty_surface_set_content_scale(surface, xScale, yScale)
        let wpx = UInt32(max(1, Int(floor(backingSize.width))))
        let hpx = UInt32(max(1, Int(floor(backingSize.height))))
        tmuxide_ghostty_surface_set_size(surface, wpx, hpx)
        tmuxide_ghostty_surface_refresh(surface)
        scheduleTick()
    }

    func refreshSurface(_ wrapper: GhosttyTerminalSurface) {
        guard let surface = wrapper.surface else { return }
        tmuxide_ghostty_surface_refresh(surface)
        scheduleTick()
    }

    // MARK: - Surface Input

    func sendText(_ text: String, to wrapper: GhosttyTerminalSurface) {
        guard let surface = wrapper.surface else { return }
        guard !text.isEmpty else { return }
        text.utf8CString.withUnsafeBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            tmuxide_ghostty_surface_text(surface, base, UInt(buffer.count - 1))
        }
        scheduleTick()
    }

    // MARK: - Tick Loop

    func scheduleTick() {
        needsTick = true
        guard !tickEnqueued else { return }
        tickEnqueued = true
        DispatchQueue.main.async { [weak self] in
            self?.tickIfNeeded()
        }
    }

    private func tickIfNeeded() {
        tickEnqueued = false
        guard needsTick else { return }
        needsTick = false

        guard let app else { return }
        tmuxide_ghostty_app_tick(app)

        if needsTick {
            scheduleTick()
        }
    }

    // MARK: - App Focus Observers

    private func synchronizeAppFocusObservers() {
        guard appObservers.isEmpty else {
            setAppFocus(NSApp.isActive)
            return
        }

        setAppFocus(NSApp.isActive)

        let center = NotificationCenter.default
        appObservers.append(
            center.addObserver(
                forName: NSApplication.didBecomeActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    self?.setAppFocus(true)
                }
            }
        )

        appObservers.append(
            center.addObserver(
                forName: NSApplication.didResignActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    self?.setAppFocus(false)
                }
            }
        )
    }

    private func setAppFocus(_ focused: Bool) {
        guard let app else { return }
        tmuxide_ghostty_app_set_focus(app, focused)
        scheduleTick()
    }

    // MARK: - Runtime Action Handling

    private static func handleRuntimeAction(target: ghostty_target_s, action: ghostty_action_s) -> Bool {
        guard let host = GhosttyAppHost.sharedOrNil else { return false }
        guard target.tag == GHOSTTY_TARGET_SURFACE else { return false }

        let surface = target.target.surface
        let key = UInt(bitPattern: Int(bitPattern: surface))
        guard let terminalSurface = host.surfaceByKey[key] else { return false }

        switch action.tag {
        case GHOSTTY_ACTION_SET_TITLE:
            if let title = action.action.set_title.title {
                host.onSurfaceTitle?(terminalSurface.sessionID, String(cString: title))
            }
            return true

        case GHOSTTY_ACTION_PWD:
            if let pwd = action.action.pwd.pwd {
                host.onSurfaceCwd?(terminalSurface.sessionID, String(cString: pwd))
            }
            return true

        case GHOSTTY_ACTION_OPEN_URL:
            let openURL = action.action.open_url
            if let cURL = openURL.url, openURL.len > 0 {
                let data = Data(bytes: cURL, count: Int(openURL.len))
                if let text = String(data: data, encoding: .utf8), let url = URL(string: text) {
                    host.onOpenURL?(terminalSurface.sessionID, url)
                }
            }
            return true

        case GHOSTTY_ACTION_DESKTOP_NOTIFICATION,
             GHOSTTY_ACTION_PROGRESS_REPORT,
             GHOSTTY_ACTION_COMMAND_FINISHED:
            host.onSurfaceAttention?(terminalSurface.sessionID)
            return true

        case GHOSTTY_ACTION_RENDER:
            host.scheduleTick()
            return true

        default:
            return false
        }
    }

    private static var sharedOrNil: GhosttyAppHost? {
        GhosttyAppHost.shared
    }
}

// MARK: - Surface Callback Context

/// Bridging context that routes C callbacks from Ghostty back to the correct
/// `GhosttyAppHost` and `GhosttyTerminalSurface` instances.
@MainActor
final class GhosttySurfaceCallbackContext {
    weak var host: GhosttyAppHost?
    weak var surface: GhosttyTerminalSurface?
    let sessionID: UUID

    init(host: GhosttyAppHost, sessionID: UUID) {
        self.host = host
        self.sessionID = sessionID
    }
}
