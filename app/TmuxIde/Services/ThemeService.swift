import Foundation
import SwiftUI

// MARK: - SwiftUI Color Helpers

extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let r = Double((int >> 16) & 0xFF) / 255
        let g = Double((int >> 8) & 0xFF) / 255
        let b = Double(int & 0xFF) / 255
        self.init(red: r, green: g, blue: b)
    }
}

extension NSColor {
    convenience init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let r = CGFloat((int >> 16) & 0xFF) / 255
        let g = CGFloat((int >> 8) & 0xFF) / 255
        let b = CGFloat(int & 0xFF) / 255
        self.init(red: r, green: g, blue: b, alpha: 1)
    }
}

// MARK: - App Theme Colors

struct AppThemeColors {
    let primaryText: Color
    let secondaryText: Color
    let tertiaryText: Color
    let mutedText: Color
    let surface0: Color        // deepest background
    let surface1: Color        // raised background
    let surface2: Color        // highest surfaces / borders
    let sidebarBackground: Color
    let divider: Color
    let accent: Color

    // NSColor for window configurator
    let nsWindowBackground: NSColor

    // Neutral grayscale dark theme — matches Apple's dark mode aesthetic.
    // No colored tints on surfaces, clean and professional.
    static let `default` = AppThemeColors(
        primaryText: Color.white.opacity(0.85),
        secondaryText: Color.white.opacity(0.55),
        tertiaryText: Color.white.opacity(0.35),
        mutedText: Color.white.opacity(0.18),
        surface0: Color(hex: "#1c1c1e"),       // Apple dark background
        surface1: Color(hex: "#2c2c2e"),       // Raised surface
        surface2: Color(hex: "#3a3a3c"),       // Highest surface
        sidebarBackground: Color(hex: "#1c1c1e"),
        divider: Color.white.opacity(0.08),
        accent: Color.accentColor,              // Respect system accent
        nsWindowBackground: NSColor(hex: "#1c1c1e")
    )
}

// MARK: - Environment Key

private struct ThemeColorsKey: EnvironmentKey {
    static let defaultValue = AppThemeColors.default
}

extension EnvironmentValues {
    var themeColors: AppThemeColors {
        get { self[ThemeColorsKey.self] }
        set { self[ThemeColorsKey.self] = newValue }
    }
}
