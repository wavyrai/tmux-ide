import AppKit
import SwiftUI

// MARK: - Window Configurator

struct WindowConfigurator: NSViewRepresentable {
    @Environment(\.themeColors) private var themeColors

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        let bgColor = themeColors.nsWindowBackground
        DispatchQueue.main.async {
            guard let window = view.window else { return }
            window.titlebarAppearsTransparent = true
            window.backgroundColor = bgColor
            window.isMovableByWindowBackground = true
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        let bgColor = themeColors.nsWindowBackground
        DispatchQueue.main.async {
            guard let window = nsView.window else { return }
            window.backgroundColor = bgColor
        }
    }
}
