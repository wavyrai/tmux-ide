import AppKit
import Foundation

/// NSView subclass that hosts a Ghostty terminal surface and handles all keyboard,
/// mouse, scroll, and drag-drop events. Routes input to Ghostty via the C bridge API.
///
/// This view also conforms to NSTextInputClient for full IME / dead-key composition.
final class GhosttyNativeView: NSView {
    weak var terminalSurface: GhosttyTerminalSurface?

    /// Optional closure invoked for every key event *instead* of routing to Ghostty.
    /// Used by MirrorTerminalController to intercept keyboard input and send it
    /// over the WebSocket to the remote tmux pane.
    var onKeyInput: ((String) -> Void)?

    private var resizeDebounceItem: DispatchWorkItem?

    /// When true, layout-triggered resizes are suppressed (e.g. during overview scaling).
    var suppressResize = false

    // MARK: - Responder

    override var acceptsFirstResponder: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // MARK: - IME State

    /// Text accumulated by insertText during interpretKeyEvents.
    private var keyTextAccumulator: [String]?
    /// Current marked (preedit / IME) text.
    private var markedTextStorage = NSMutableAttributedString()
    private var markedRange_ = NSRange(location: NSNotFound, length: 0)
    private var selectedRange_ = NSRange(location: 0, length: 0)

    // MARK: - Lifecycle

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        registerForDraggedTypes([.fileURL, .URL, .string])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func prepareForSurfaceTeardown() {
        resizeDebounceItem?.cancel()
        resizeDebounceItem = nil

        if window?.firstResponder === self {
            window?.makeFirstResponder(nil)
        }

        terminalSurface = nil
        removeFromSuperview()
    }

    // MARK: - View Lifecycle

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil else { return }

        // Create the surface now that the view is in a window (deferred from init).
        // Ghostty needs the window to get display ID and backing scale factor.
        terminalSurface?.createSurfaceIfNeeded()
        terminalSurface?.resizeToCurrentViewBounds()

        if window?.isKeyWindow == true {
            DispatchQueue.main.async { [weak self] in
                self?.terminalSurface?.focus()
            }
        }
    }

    override func layout() {
        super.layout()
        guard !suppressResize else { return }

        // Debounce resize (50ms) to coalesce rapid layout changes.
        resizeDebounceItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, !self.suppressResize else { return }
            self.terminalSurface?.resizeToCurrentViewBounds()
        }
        resizeDebounceItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: item)
    }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became {
            terminalSurface?.focus()
        }
        return became
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned {
            terminalSurface?.blur()
        }
        return resigned
    }

    // MARK: - Mouse Events

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        terminalSurface?.focus()
        guard let surface = terminalSurface?.surface else { return }
        let pos = convertToSurfacePoint(event)
        tmuxide_ghostty_surface_mouse_pos(surface, pos.x, pos.y, modsFromEvent(event))
        tmuxide_ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, modsFromEvent(event))
        GhosttyAppHost.shared.scheduleTick()
    }

    override func mouseUp(with event: NSEvent) {
        guard let surface = terminalSurface?.surface else { return }
        let pos = convertToSurfacePoint(event)
        tmuxide_ghostty_surface_mouse_pos(surface, pos.x, pos.y, modsFromEvent(event))
        tmuxide_ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, modsFromEvent(event))
        GhosttyAppHost.shared.scheduleTick()
    }

    override func mouseDragged(with event: NSEvent) {
        guard let surface = terminalSurface?.surface else { return }
        let pos = convertToSurfacePoint(event)
        tmuxide_ghostty_surface_mouse_pos(surface, pos.x, pos.y, modsFromEvent(event))
        GhosttyAppHost.shared.scheduleTick()
    }

    override func mouseMoved(with event: NSEvent) {
        guard let surface = terminalSurface?.surface else { return }
        let pos = convertToSurfacePoint(event)
        tmuxide_ghostty_surface_mouse_pos(surface, pos.x, pos.y, modsFromEvent(event))
    }

    override func rightMouseDown(with event: NSEvent) {
        guard let surface = terminalSurface?.surface else {
            super.rightMouseDown(with: event)
            return
        }
        let pos = convertToSurfacePoint(event)
        tmuxide_ghostty_surface_mouse_pos(surface, pos.x, pos.y, modsFromEvent(event))
        tmuxide_ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_RIGHT, modsFromEvent(event))
        GhosttyAppHost.shared.scheduleTick()
    }

    override func rightMouseUp(with event: NSEvent) {
        guard let surface = terminalSurface?.surface else { return }
        let pos = convertToSurfacePoint(event)
        tmuxide_ghostty_surface_mouse_pos(surface, pos.x, pos.y, modsFromEvent(event))
        tmuxide_ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_RIGHT, modsFromEvent(event))
        GhosttyAppHost.shared.scheduleTick()
    }

    override func rightMouseDragged(with event: NSEvent) {
        guard let surface = terminalSurface?.surface else { return }
        let pos = convertToSurfacePoint(event)
        tmuxide_ghostty_surface_mouse_pos(surface, pos.x, pos.y, modsFromEvent(event))
        GhosttyAppHost.shared.scheduleTick()
    }

    override func scrollWheel(with event: NSEvent) {
        guard let surface = terminalSurface?.surface else { return }

        var x = event.scrollingDeltaX
        var y = event.scrollingDeltaY
        let precision = event.hasPreciseScrollingDeltas

        if precision {
            // Match Ghostty's 2x multiplier for trackpad feel
            x *= 2
            y *= 2
        }

        // Pack scroll mods: bit 0 = precision, bits 1-3 = momentum phase
        var scrollMods: Int32 = 0
        if precision {
            scrollMods |= 0b0000_0001
        }
        let momentum: Int32 = switch event.momentumPhase {
        case .began:      1
        case .stationary: 2
        case .changed:    3
        case .ended:      4
        case .cancelled:  5
        case .mayBegin:   6
        default:          0
        }
        scrollMods |= momentum << 1

        tmuxide_ghostty_surface_mouse_scroll(surface, x, y, scrollMods)
        GhosttyAppHost.shared.scheduleTick()
    }

    private func convertToSurfacePoint(_ event: NSEvent) -> NSPoint {
        let local = convert(event.locationInWindow, from: nil)
        // Ghostty expects top-left origin
        return NSPoint(x: local.x, y: bounds.height - local.y)
    }

    // MARK: - Drag and Drop

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        droppedFileURLs(from: sender.draggingPasteboard).isEmpty ? [] : .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        draggingEntered(sender)
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        !droppedFileURLs(from: sender.draggingPasteboard).isEmpty
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let fileURLs = droppedFileURLs(from: sender.draggingPasteboard)
        guard !fileURLs.isEmpty else { return false }

        let escapedPaths = fileURLs.map { GhosttyAppHost.shellEscapedCommand($0.path) }
        let insertion = escapedPaths.joined(separator: " ")
        guard !insertion.isEmpty else { return false }

        window?.makeFirstResponder(self)
        terminalSurface?.focus()

        if let onKeyInput {
            // Mirror mode: send dropped paths as text over WebSocket
            onKeyInput("\(insertion) ")
        } else {
            terminalSurface?.send(text: "\(insertion) ")
        }
        return true
    }

    private func droppedFileURLs(from pasteboard: NSPasteboard) -> [URL] {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [
            .urlReadingFileURLsOnly: true,
        ]
        guard let nsURLs = pasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [NSURL] else {
            return []
        }
        return nsURLs.compactMap { url in
            let asURL = url as URL
            return asURL.isFileURL ? asURL : nil
        }
    }

    // MARK: - Keyboard Events

    override func keyDown(with event: NSEvent) {
        // If we have a mirror input handler, intercept and send text over WebSocket
        if let onKeyInput {
            handleMirrorKeyDown(event, onKeyInput: onKeyInput)
            return
        }

        guard let surface = terminalSurface?.surface else {
            super.keyDown(with: event)
            return
        }

        // Command key events bypass ghostty and go to macOS menu handling
        if event.modifierFlags.contains(.command) {
            super.keyDown(with: event)
            return
        }

        // Ensure ghostty knows we have focus
        tmuxide_ghostty_surface_set_focus(surface, true)

        // Fast path for Ctrl-modified keys (Ctrl+C, Ctrl+D, etc.)
        // Bypass IME and send directly to ghostty
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags.contains(.control) && !flags.contains(.option) && !hasMarkedText() {
            var keyEvent = ghostty_input_key_s()
            keyEvent.action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS
            keyEvent.keycode = UInt32(event.keyCode)
            keyEvent.mods = modsFromEvent(event)
            keyEvent.consumed_mods = GHOSTTY_MODS_NONE
            keyEvent.composing = false
            keyEvent.unshifted_codepoint = unshiftedCodepointFromEvent(event)

            let text = event.charactersIgnoringModifiers ?? event.characters ?? ""
            if text.isEmpty {
                keyEvent.text = nil
                let handled = tmuxide_ghostty_surface_key(surface, keyEvent)
                if handled {
                    GhosttyAppHost.shared.scheduleTick()
                    return
                }
            } else {
                let handled = text.withCString { ptr -> Bool in
                    keyEvent.text = ptr
                    return tmuxide_ghostty_surface_key(surface, keyEvent)
                }
                if handled {
                    GhosttyAppHost.shared.scheduleTick()
                    return
                }
            }
        }

        let action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS

        // Translate mods to respect ghostty config (e.g. macos-option-as-alt)
        let translationModsGhostty = tmuxide_ghostty_surface_key_translation_mods(surface, modsFromEvent(event))
        var translationMods = event.modifierFlags
        for flag in [NSEvent.ModifierFlags.shift, .control, .option, .command] {
            let hasFlag: Bool
            switch flag {
            case .shift:
                hasFlag = (translationModsGhostty.rawValue & GHOSTTY_MODS_SHIFT.rawValue) != 0
            case .control:
                hasFlag = (translationModsGhostty.rawValue & GHOSTTY_MODS_CTRL.rawValue) != 0
            case .option:
                hasFlag = (translationModsGhostty.rawValue & GHOSTTY_MODS_ALT.rawValue) != 0
            case .command:
                hasFlag = (translationModsGhostty.rawValue & GHOSTTY_MODS_SUPER.rawValue) != 0
            default:
                hasFlag = translationMods.contains(flag)
            }
            if hasFlag {
                translationMods.insert(flag)
            } else {
                translationMods.remove(flag)
            }
        }

        let translationEvent: NSEvent
        if translationMods == event.modifierFlags {
            translationEvent = event
        } else {
            translationEvent = NSEvent.keyEvent(
                with: event.type,
                location: event.locationInWindow,
                modifierFlags: translationMods,
                timestamp: event.timestamp,
                windowNumber: event.windowNumber,
                context: nil,
                characters: event.characters(byApplyingModifiers: translationMods) ?? "",
                charactersIgnoringModifiers: event.charactersIgnoringModifiers ?? "",
                isARepeat: event.isARepeat,
                keyCode: event.keyCode
            ) ?? event
        }

        // Set up text accumulator for interpretKeyEvents
        keyTextAccumulator = []
        defer { keyTextAccumulator = nil }

        let markedTextBefore = markedTextStorage.length > 0

        // Let the input system handle the event (for IME, dead keys, etc.)
        interpretKeyEvents([translationEvent])

        // Build the key event
        var keyEvent = ghostty_input_key_s()
        keyEvent.action = action
        keyEvent.keycode = UInt32(event.keyCode)
        keyEvent.mods = modsFromEvent(event)
        keyEvent.consumed_mods = consumedModsFromFlags(translationMods)
        keyEvent.unshifted_codepoint = unshiftedCodepointFromEvent(event)
        keyEvent.composing = markedTextStorage.length > 0 || markedTextBefore

        let accumulatedText = keyTextAccumulator ?? []
        if !accumulatedText.isEmpty {
            // Text from insertText (IME result) — not composing
            keyEvent.composing = false
            for text in accumulatedText {
                text.withCString { ptr in
                    keyEvent.text = ptr
                    _ = tmuxide_ghostty_surface_key(surface, keyEvent)
                }
            }
        } else {
            // Get text for this key event
            if let text = textForKeyEvent(translationEvent) {
                text.withCString { ptr in
                    keyEvent.text = ptr
                    _ = tmuxide_ghostty_surface_key(surface, keyEvent)
                }
            } else {
                keyEvent.text = nil
                _ = tmuxide_ghostty_surface_key(surface, keyEvent)
            }
        }

        GhosttyAppHost.shared.scheduleTick()
    }

    override func keyUp(with event: NSEvent) {
        // Mirror mode does not need key-up handling
        if onKeyInput != nil { return }

        guard let surface = terminalSurface?.surface else {
            super.keyUp(with: event)
            return
        }

        if event.modifierFlags.contains(.command) {
            super.keyUp(with: event)
            return
        }

        var keyEvent = ghostty_input_key_s()
        keyEvent.action = GHOSTTY_ACTION_RELEASE
        keyEvent.keycode = UInt32(event.keyCode)
        keyEvent.mods = modsFromEvent(event)
        keyEvent.consumed_mods = GHOSTTY_MODS_NONE
        keyEvent.text = nil
        keyEvent.composing = false
        keyEvent.unshifted_codepoint = 0
        _ = tmuxide_ghostty_surface_key(surface, keyEvent)
    }

    override func flagsChanged(with event: NSEvent) {
        guard let surface = terminalSurface?.surface else {
            super.flagsChanged(with: event)
            return
        }

        var keyEvent = ghostty_input_key_s()
        keyEvent.action = GHOSTTY_ACTION_PRESS
        keyEvent.keycode = UInt32(event.keyCode)
        keyEvent.mods = modsFromEvent(event)
        keyEvent.consumed_mods = GHOSTTY_MODS_NONE
        keyEvent.text = nil
        keyEvent.composing = false
        keyEvent.unshifted_codepoint = 0
        _ = tmuxide_ghostty_surface_key(surface, keyEvent)
    }

    // MARK: - Mirror Key Handling

    /// Handles keyboard input when in mirror mode. Translates key events into
    /// text strings and sends them via the `onKeyInput` closure (which routes
    /// them over the WebSocket to the tmux pane).
    private func handleMirrorKeyDown(_ event: NSEvent, onKeyInput: @escaping (String) -> Void) {
        // Command key events go to macOS menu handling
        if event.modifierFlags.contains(.command) {
            super.keyDown(with: event)
            return
        }

        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)

        // Control key combos: send the control character
        if flags.contains(.control) {
            if let chars = event.charactersIgnoringModifiers,
               let scalar = chars.unicodeScalars.first,
               scalar.value >= 0x40 && scalar.value <= 0x7E
            {
                // Convert to control character (e.g. 'c' -> 0x03 for Ctrl+C)
                let controlChar = Character(UnicodeScalar(scalar.value & 0x1F)!)
                onKeyInput(String(controlChar))
                return
            }
        }

        // Special keys by keyCode
        let specialKey: String? = switch event.keyCode {
        case 36:  "\r"       // Return
        case 48:  "\t"       // Tab
        case 51:  "\u{7F}"   // Delete (backspace)
        case 53:  "\u{1B}"   // Escape
        case 123: "\u{1B}[D" // Left arrow
        case 124: "\u{1B}[C" // Right arrow
        case 125: "\u{1B}[B" // Down arrow
        case 126: "\u{1B}[A" // Up arrow
        case 115: "\u{1B}[H" // Home
        case 119: "\u{1B}[F" // End
        case 116: "\u{1B}[5~" // Page Up
        case 121: "\u{1B}[6~" // Page Down
        default:  nil
        }

        if let specialKey {
            onKeyInput(specialKey)
            return
        }

        // Regular text input
        if let chars = event.characters, !chars.isEmpty {
            // Skip function key range (PUA characters)
            if let scalar = chars.unicodeScalars.first,
               scalar.value >= 0xF700 && scalar.value <= 0xF8FF
            {
                return
            }
            onKeyInput(chars)
        }
    }

    // MARK: - Input Helpers

    private func modsFromEvent(_ event: NSEvent) -> ghostty_input_mods_e {
        var mods = GHOSTTY_MODS_NONE.rawValue
        if event.modifierFlags.contains(.shift) { mods |= GHOSTTY_MODS_SHIFT.rawValue }
        if event.modifierFlags.contains(.control) { mods |= GHOSTTY_MODS_CTRL.rawValue }
        if event.modifierFlags.contains(.option) { mods |= GHOSTTY_MODS_ALT.rawValue }
        if event.modifierFlags.contains(.command) { mods |= GHOSTTY_MODS_SUPER.rawValue }
        return ghostty_input_mods_e(rawValue: mods)
    }

    private func consumedModsFromFlags(_ flags: NSEvent.ModifierFlags) -> ghostty_input_mods_e {
        var mods = GHOSTTY_MODS_NONE.rawValue
        if flags.contains(.shift) { mods |= GHOSTTY_MODS_SHIFT.rawValue }
        if flags.contains(.option) { mods |= GHOSTTY_MODS_ALT.rawValue }
        return ghostty_input_mods_e(rawValue: mods)
    }

    private func unshiftedCodepointFromEvent(_ event: NSEvent) -> UInt32 {
        guard let chars = event.charactersIgnoringModifiers, let scalar = chars.unicodeScalars.first else {
            return 0
        }
        return scalar.value
    }

    private func textForKeyEvent(_ event: NSEvent) -> String? {
        guard let chars = event.characters, !chars.isEmpty else { return nil }

        if chars.count == 1, let scalar = chars.unicodeScalars.first {
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)

            // Function keys (arrows, F1-F12, Home, End, etc.) use Unicode PUA
            // characters (0xF700+). Don't send these as text.
            if scalar.value >= 0xF700 && scalar.value <= 0xF8FF {
                return nil
            }

            // If we have a control character, return the character without the
            // control modifier so ghostty's KeyEncoder can handle it
            if scalar.value < 0x20 {
                if flags.contains(.control) {
                    return event.characters(byApplyingModifiers: event.modifierFlags.subtracting(.control))
                }
                // Non-control-modified control chars (Return, Tab, Escape)
                return chars
            }
        }

        return chars
    }
}

// MARK: - NSTextInputClient

extension GhosttyNativeView: @preconcurrency NSTextInputClient {
    func insertText(_ string: Any, replacementRange: NSRange) {
        let text: String
        if let s = string as? String {
            text = s
        } else if let s = string as? NSAttributedString {
            text = s.string
        } else {
            return
        }

        // Clear any marked text since we're committing
        markedTextStorage.mutableString.setString("")
        markedRange_ = NSRange(location: NSNotFound, length: 0)
        selectedRange_ = NSRange(location: 0, length: 0)

        keyTextAccumulator?.append(text)
    }

    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        if let s = string as? String {
            markedTextStorage.mutableString.setString(s)
        } else if let s = string as? NSAttributedString {
            markedTextStorage.setAttributedString(s)
        }

        if markedTextStorage.length > 0 {
            markedRange_ = NSRange(location: 0, length: markedTextStorage.length)
        } else {
            markedRange_ = NSRange(location: NSNotFound, length: 0)
        }
        selectedRange_ = selectedRange
    }

    func unmarkText() {
        markedTextStorage.mutableString.setString("")
        markedRange_ = NSRange(location: NSNotFound, length: 0)
    }

    func selectedRange() -> NSRange {
        selectedRange_
    }

    func markedRange() -> NSRange {
        markedRange_
    }

    func hasMarkedText() -> Bool {
        markedRange_.location != NSNotFound && markedRange_.length > 0
    }

    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? {
        nil
    }

    func validAttributesForMarkedText() -> [NSAttributedString.Key] {
        []
    }

    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        guard let window else { return .zero }
        let viewRect = convert(bounds, to: nil)
        return window.convertToScreen(viewRect)
    }

    func characterIndex(for point: NSPoint) -> Int {
        0
    }

    override func doCommand(by selector: Selector) {
        // interpretKeyEvents routes non-text keys (return, arrows, delete, etc.)
        // through AppKit command selectors. Ghostty handles the key stream
        // directly in keyDown/keyUp, so swallow these selectors.
        if terminalSurface?.surface != nil {
            return
        }
        super.doCommand(by: selector)
    }

    // MARK: - Edit Menu Actions (Cmd+C, Cmd+V, Cmd+A)

    private func performSurfaceAction(_ action: String) -> Bool {
        guard let surface = terminalSurface?.surface else { return false }
        return tmuxide_ghostty_surface_binding_action(surface, action, UInt(action.utf8.count))
    }

    @IBAction func copy(_ sender: Any?) {
        _ = performSurfaceAction("copy_to_clipboard")
    }

    @IBAction func paste(_ sender: Any?) {
        if let onKeyInput {
            // Mirror mode: paste from clipboard and send over WebSocket
            if let text = NSPasteboard.general.string(forType: .string) {
                onKeyInput(text)
            }
        } else {
            _ = performSurfaceAction("paste_from_clipboard")
        }
    }

    @IBAction override func selectAll(_ sender: Any?) {
        if !performSurfaceAction("select_all") {
            super.selectAll(sender)
        }
    }
}
