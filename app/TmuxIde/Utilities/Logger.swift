import Foundation
import os

enum Logger {
    private static let subsystem = "com.tmux-ide.app"
    private static let base = os.Logger(subsystem: subsystem, category: "app")

    static func info(_ message: String) {
        base.info("\(message, privacy: .public)")
    }

    static func warning(_ message: String) {
        base.warning("\(message, privacy: .public)")
    }

    static func error(_ message: String) {
        base.error("\(message, privacy: .public)")
    }
}
