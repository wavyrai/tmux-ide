import AppKit

// MARK: - Shortcut Key

/// Represents the key component of a shortcut — either a character or a special key.
enum ShortcutKey: Hashable {
    case character(Character)
    case upArrow
    case downArrow

    func matches(_ event: NSEvent) -> Bool {
        switch self {
        case .character(let ch):
            guard let chars = event.charactersIgnoringModifiers else { return false }
            return chars.lowercased() == String(ch).lowercased()
        case .upArrow:
            return event.specialKey == .upArrow
        case .downArrow:
            return event.specialKey == .downArrow
        }
    }
}

// MARK: - Shortcut Entry

/// A single keyboard shortcut binding: key + modifiers → action ID.
struct ShortcutEntry: Identifiable {
    let id: String // actionId
    let key: ShortcutKey
    let modifiers: NSEvent.ModifierFlags
    /// Human-readable label (e.g., "⌘K") shown in the command palette.
    let label: String
}

// MARK: - Shortcut Registry

/// Holds all registered keyboard shortcuts and provides matching against NSEvents.
final class ShortcutRegistry {
    private(set) var entries: [ShortcutEntry] = []

    init() {
        registerDefaults()
    }

    /// Look up the human-readable label for an action ID (e.g., "⌘]").
    func label(for actionId: String) -> String? {
        entries.first { $0.id == actionId }?.label
    }

    /// Find the shortcut entry matching an NSEvent, if any.
    func match(_ event: NSEvent) -> ShortcutEntry? {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        return entries.first { entry in
            entry.key.matches(event) && flags == entry.modifiers
        }
    }

    // MARK: - Default shortcuts

    private func registerDefaults() {
        // Cmd+K — command palette
        register("command-palette", key: .character("k"), modifiers: .command, label: "⌘K")

        // Cmd+1 through Cmd+9 — focus session by index
        for i in 1...9 {
            register(
                "focus-session-\(i)",
                key: .character(Character("\(i)")),
                modifiers: .command,
                label: "⌘\(i)"
            )
        }

        // Cmd+T — add terminal tile
        register("add-terminal", key: .character("t"), modifiers: .command, label: "⌘T")

        // Cmd+Shift+B — add browser tile
        register("add-browser", key: .character("b"), modifiers: [.command, .shift], label: "⌘⇧B")

        // Cmd+[ / Cmd+] — focus prev/next column
        register("focus-prev", key: .character("["), modifiers: .command, label: "⌘[")
        register("focus-next", key: .character("]"), modifiers: .command, label: "⌘]")

        // Cmd+Up / Cmd+Down — focus prev/next item in column
        register("focus-up", key: .upArrow, modifiers: .command, label: "⌘↑")
        register("focus-down", key: .downArrow, modifiers: .command, label: "⌘↓")

        // Cmd+Shift+O — toggle overview
        register("toggle-overview", key: .character("o"), modifiers: [.command, .shift], label: "⌘⇧O")
    }

    private func register(_ actionId: String, key: ShortcutKey, modifiers: NSEvent.ModifierFlags, label: String) {
        entries.append(ShortcutEntry(id: actionId, key: key, modifiers: modifiers, label: label))
    }
}
