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

    static let `default` = AppThemeColors(
        primaryText: Color.white.opacity(0.87),
        secondaryText: Color.white.opacity(0.55),
        tertiaryText: Color.white.opacity(0.35),
        mutedText: Color.white.opacity(0.2),
        surface0: Color(hex: "#1a1a2e"),
        surface1: Color(hex: "#222244"),
        surface2: Color(hex: "#2a2a50"),
        sidebarBackground: Color(hex: "#16162a"),
        divider: Color(hex: "#333366"),
        accent: Color(hex: "#7c6cf0"),
        nsWindowBackground: NSColor(hex: "#1a1a2e")
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
