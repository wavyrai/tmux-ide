import Foundation

// MARK: - Tunnel Status

enum TunnelStatus: Equatable, Sendable {
    case idle
    case connecting
    case connected(localPort: Int)
    case error(String)

    var isActive: Bool {
        switch self {
        case .connecting, .connected: true
        default: false
        }
    }

    var displayLabel: String {
        switch self {
        case .idle: "Idle"
        case .connecting: "Establishing tunnel..."
        case .connected(let port): "Tunnel on :\(port)"
        case .error(let msg): "Error: \(msg)"
        }
    }
}

// MARK: - SSH Tunnel Service

/// Manages SSH port-forward tunnels for remote command-center connections.
/// Spawns `ssh -N -L localPort:localhost:remotePort host` subprocesses,
/// monitors them for exit, and auto-restarts on failure.
@MainActor
final class SSHTunnelService: ObservableObject {

    @Published private(set) var statuses: [UUID: TunnelStatus] = [:]

    private var tunnels: [UUID: TunnelInfo] = [:]
    private var monitorTasks: [UUID: Task<Void, Never>] = [:]

    private static let basePort = 14000
    private static let maxRestarts = 5
    private static let restartDelay: UInt64 = 2_000_000_000 // 2 seconds

    // MARK: - Tunnel Info

    private struct TunnelInfo {
        let targetID: UUID
        var process: Process
        var localPort: Int
        var restartCount: Int = 0
    }

    // MARK: - Open Tunnel

    /// Start an SSH tunnel for the given target. Returns the local port being forwarded.
    /// The tunnel runs `ssh -N -L localPort:localhost:remotePort host`.
    @discardableResult
    func openTunnel(for target: ConnectionTarget) -> Int {
        // If there's already an active tunnel, reuse its port
        if let existing = tunnels[target.id], existing.process.isRunning {
            return existing.localPort
        }

        // Clean up any stale state
        closeTunnel(for: target.id)

        let localPort = pickFreePort()
        statuses[target.id] = .connecting

        do {
            let process = try spawnSSH(host: target.host, remotePort: target.port, localPort: localPort)
            tunnels[target.id] = TunnelInfo(
                targetID: target.id,
                process: process,
                localPort: localPort
            )

            startMonitoring(targetID: target.id, target: target)
            return localPort
        } catch {
            statuses[target.id] = .error(error.localizedDescription)
            return localPort
        }
    }

    // MARK: - Close Tunnel

    func closeTunnel(for targetID: UUID) {
        monitorTasks[targetID]?.cancel()
        monitorTasks.removeValue(forKey: targetID)

        if let info = tunnels.removeValue(forKey: targetID) {
            if info.process.isRunning {
                info.process.terminate()
            }
        }

        statuses[targetID] = .idle
    }

    /// Close all tunnels (app termination).
    func closeAll() {
        for id in Array(tunnels.keys) {
            closeTunnel(for: id)
        }
    }

    // MARK: - Port for Target

    /// Returns the local port for an active tunnel, or nil if not connected.
    func localPort(for targetID: UUID) -> Int? {
        tunnels[targetID]?.localPort
    }

    // MARK: - SSH Process

    private func spawnSSH(host: String, remotePort: Int, localPort: Int) throws -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = [
            "-N",                                               // No remote command
            "-o", "ExitOnForwardFailure=yes",                   // Fail if port forward fails
            "-o", "ServerAliveInterval=15",                     // Keep-alive every 15s
            "-o", "ServerAliveCountMax=3",                      // Disconnect after 3 missed
            "-o", "ConnectTimeout=10",                          // 10s connection timeout
            "-o", "StrictHostKeyChecking=accept-new",           // Auto-accept new hosts
            "-L", "\(localPort):localhost:\(remotePort)",       // Port forward
            host                                                // SSH destination (uses ~/.ssh/config)
        ]

        // Suppress stdout/stderr from cluttering the app
        process.standardOutput = FileHandle.nullDevice
        process.standardError = Pipe() // Capture stderr for error messages

        try process.run()
        return process
    }

    // MARK: - Monitoring

    private func startMonitoring(targetID: UUID, target: ConnectionTarget) {
        monitorTasks[targetID]?.cancel()

        let task = Task { [weak self] in
            // Give SSH a moment to establish the connection
            try? await Task.sleep(nanoseconds: 1_500_000_000) // 1.5s
            guard !Task.isCancelled else { return }

            // Check if process is still running (means tunnel is up)
            guard let self else { return }
            if let info = tunnels[targetID], info.process.isRunning {
                statuses[targetID] = .connected(localPort: info.localPort)
            }

            // Now wait for process termination
            await waitForTermination(targetID: targetID, target: target)
        }
        monitorTasks[targetID] = task
    }

    private func waitForTermination(targetID: UUID, target: ConnectionTarget) async {
        guard let info = tunnels[targetID] else { return }

        // Poll for process termination (Process.waitUntilExit() blocks the thread)
        while !Task.isCancelled {
            if !info.process.isRunning {
                break
            }
            try? await Task.sleep(nanoseconds: 500_000_000) // 0.5s poll
        }

        guard !Task.isCancelled else { return }

        // Process exited — check if we should restart
        let exitCode = info.process.terminationStatus
        let stderr = readStderr(from: info.process)

        let currentRestartCount = tunnels[targetID]?.restartCount ?? 0

        if currentRestartCount < Self.maxRestarts {
            let errorMsg = stderr.isEmpty ? "SSH exited (\(exitCode))" : stderr
            statuses[targetID] = .error(errorMsg)

            // Wait before restarting
            try? await Task.sleep(nanoseconds: Self.restartDelay)
            guard !Task.isCancelled else { return }

            // Restart with the same local port
            let localPort = info.localPort
            tunnels.removeValue(forKey: targetID)

            statuses[targetID] = .connecting
            do {
                let newProcess = try spawnSSH(host: target.host, remotePort: target.port, localPort: localPort)
                tunnels[targetID] = TunnelInfo(
                    targetID: targetID,
                    process: newProcess,
                    localPort: localPort,
                    restartCount: currentRestartCount + 1
                )
                startMonitoring(targetID: targetID, target: target)
            } catch {
                statuses[targetID] = .error(error.localizedDescription)
            }
        } else {
            let errorMsg = stderr.isEmpty ? "Tunnel failed after \(Self.maxRestarts) retries" : stderr
            statuses[targetID] = .error(errorMsg)
            tunnels.removeValue(forKey: targetID)
        }
    }

    private func readStderr(from process: Process) -> String {
        guard let pipe = process.standardError as? Pipe else { return "" }
        let data = pipe.fileHandleForReading.availableData
        let raw = String(data: data, encoding: .utf8) ?? ""
        // Return first line, trimmed, max 80 chars for display
        let firstLine = raw.components(separatedBy: .newlines).first(where: { !$0.isEmpty }) ?? ""
        return String(firstLine.prefix(80))
    }

    // MARK: - Port Allocation

    private func pickFreePort() -> Int {
        let usedPorts = Set(tunnels.values.map(\.localPort))
        var candidate = Self.basePort
        while usedPorts.contains(candidate) {
            candidate += 1
        }
        return candidate
    }
}
