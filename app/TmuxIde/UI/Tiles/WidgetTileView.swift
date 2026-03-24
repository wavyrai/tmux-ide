import SwiftUI

/// A tile that runs an OpenTUI widget inside a Ghostty terminal surface.
///
/// Widgets are Bun scripts (e.g., mission-control, explorer, tasks) that
/// render TUI interfaces. Each widget tile runs:
///   cd {projectDir} && bun src/widgets/{type}/index.tsx --session={session} --dir={dir}
struct WidgetTileView: View {
    let command: String
    let sessionName: String

    @StateObject private var controller = WidgetController()

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
                            Text("Loading widget...")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
            }
        }
        .onAppear {
            controller.launch(command: command, session: sessionName)
        }
        .onDisappear {
            controller.stop()
        }
    }
}

@MainActor
final class WidgetController: ObservableObject {
    @Published private(set) var surface: GhosttyTerminalSurface?

    func launch(command: String, session: String) {
        guard surface == nil else { return }

        let cwd = projectDir(for: session)

        let wrapper = GhosttyAppHost.shared.makeSurface(
            sessionID: UUID(),
            workingDirectory: cwd,
            shellPath: "/bin/zsh"
        )

        surface = wrapper

        // Send the widget command after the shell starts
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak wrapper] in
            guard let wrapper else { return }
            wrapper.send(text: command + "\n")
        }
    }

    func stop() {
        surface = nil
    }

    private func projectDir(for session: String) -> String {
        let result = try? shellOutput("/usr/bin/tmux", args: [
            "display-message", "-t", session, "-p", "#{pane_current_path}"
        ])
        return result?.trimmingCharacters(in: .whitespacesAndNewlines) ?? NSHomeDirectory()
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
