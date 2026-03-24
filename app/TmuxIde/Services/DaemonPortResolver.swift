import Foundation

/// Discovers tmux-ide daemon ports by querying tmux session options.
///
/// Each tmux-ide daemon writes its HTTP port to the tmux session option
/// `@command_center_port`. This resolver queries tmux to find all active
/// daemon ports for local sessions.
enum DaemonPortResolver {

    struct DiscoveredDaemon: Sendable {
        let sessionName: String
        let port: Int
    }

    /// Discover all local tmux-ide daemon ports.
    /// Returns one entry per session that has `@command_center_port` set.
    static func discoverAll() async -> [DiscoveredDaemon] {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let sessions = listTmuxSessions()
                var daemons: [DiscoveredDaemon] = []
                for session in sessions {
                    if let port = getDaemonPort(session: session) {
                        daemons.append(DiscoveredDaemon(sessionName: session, port: port))
                    }
                }
                continuation.resume(returning: daemons)
            }
        }
    }

    /// Get the daemon port for a specific tmux session.
    /// Returns nil if the session doesn't have a daemon running.
    static func getPort(session: String) async -> Int? {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: getDaemonPort(session: session))
            }
        }
    }

    /// Discover any single local daemon port (first found).
    /// Useful as a fallback for the default local connection target.
    static func discoverAnyPort() async -> Int? {
        let daemons = await discoverAll()
        return daemons.first?.port
    }

    // MARK: - Private

    private static func listTmuxSessions() -> [String] {
        guard let output = runProcess("/usr/bin/env", arguments: ["tmux", "list-sessions", "-F", "#{session_name}"]) else {
            return []
        }
        return output
            .split(separator: "\n")
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private static func getDaemonPort(session: String) -> Int? {
        guard let output = runProcess("/usr/bin/env", arguments: [
            "tmux", "show-option", "-qvt", session, "@command_center_port"
        ]) else {
            return nil
        }
        return Int(output.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private static func runProcess(_ path: String, arguments: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)
        } catch {
            return nil
        }
    }
}
