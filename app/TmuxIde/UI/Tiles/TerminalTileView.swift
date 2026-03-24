import SwiftUI

/// A terminal tile that attaches to a tmux session.
///
/// Runs `tmux attach-session -t {session}` inside a Ghostty surface.
/// The user sees the full tmux layout with all panes and can switch
/// between them using tmux keybindings. When the app closes, tmux
/// detaches — all processes keep running.
struct TerminalTileView: View {
    let paneId: String
    let baseURL: URL
    let sessionName: String

    @StateObject private var controller = TmuxSessionController()

    var body: some View {
        ZStack {
            if let surface = controller.surface {
                InlineTerminalView(surface: surface)
            } else {
                Color(nsColor: .textBackgroundColor)
                    .overlay {
                        VStack(spacing: 8) {
                            ProgressView()
                                .controlSize(.small)
                            Text("Attaching to \(sessionName)...")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
            }
        }
        .onAppear {
            controller.attach(session: sessionName)
        }
        .onDisappear {
            controller.detach()
        }
    }
}

// MARK: - Tmux Session Controller

/// Creates a Ghostty surface that runs `tmux attach-session`.
/// The terminal shows the full tmux session — all panes, status bar, everything.
/// Processes are persistent in tmux; closing the app just detaches.
@MainActor
final class TmuxSessionController: ObservableObject {
    @Published private(set) var surface: GhosttyTerminalSurface?

    func attach(session: String) {
        guard surface == nil else { return }

        // Find the project directory from tmux
        let cwd = projectDir(for: session)

        let wrapper = GhosttyAppHost.shared.makeSurface(
            sessionID: UUID(),
            workingDirectory: cwd,
            shellPath: "/bin/zsh"
        )

        // After the surface creates its shell, send the tmux attach command.
        // This way Ghostty runs zsh which then runs tmux attach.
        // When the user detaches (Ctrl+B d), they're back at a shell.
        wrapper?.rawCommand = "tmux attach-session -t \(shellEscape(session))"

        surface = wrapper
    }

    func detach() {
        surface = nil
    }

    private func projectDir(for session: String) -> String {
        // Ask tmux for the session's working directory
        let result = try? shellOutput("/usr/bin/tmux", args: [
            "display-message", "-t", session, "-p", "#{pane_current_path}"
        ])
        return result?.trimmingCharacters(in: .whitespacesAndNewlines) ?? NSHomeDirectory()
    }

    private func shellEscape(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private func shellOutput(_ cmd: String, args: [String]) throws -> String {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: cmd)
        process.arguments = args
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }
}
