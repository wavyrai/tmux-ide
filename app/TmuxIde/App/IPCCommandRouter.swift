import AppKit
import Foundation

/// Routes IPC commands to the appropriate app services.
///
/// Handles commands defined in `IPCCommand` by dispatching to the
/// connection manager, discovery service, canvas service, and command
/// center client as appropriate.
@MainActor
final class IPCCommandRouter {
    private weak var coordinator: AppCoordinator?
    private let connectionManager: ConnectionManager
    private let discoveryService: SessionDiscoveryService

    init(coordinator: AppCoordinator) {
        self.coordinator = coordinator
        self.connectionManager = coordinator.connectionManager
        self.discoveryService = coordinator.discoveryService
    }

    func handle(_ request: IPCRequest) -> IPCResponse {
        switch request.command {
        case IPCCommand.open:
            return handleOpen()

        case IPCCommand.listSessions:
            return handleListSessions()

        case IPCCommand.focusSession:
            return handleFocusSession(request.payload)

        case IPCCommand.launch:
            return handleLaunch(request.payload)

        case IPCCommand.stop:
            return handleStop(request.payload)

        case IPCCommand.restart:
            return handleRestart(request.payload)

        case IPCCommand.send:
            return handleSend(request.payload)

        case IPCCommand.addTile:
            return handleAddTile(request.payload)

        case IPCCommand.removeTile:
            return handleRemoveTile(request.payload)

        case IPCCommand.taskList:
            return handleTaskList(request.payload)

        case IPCCommand.taskCreate:
            return handleTaskCreate(request.payload)

        case IPCCommand.taskUpdate:
            return handleTaskUpdate(request.payload)

        case IPCCommand.orchestratorStatus:
            return handleOrchestratorStatus(request.payload)

        case IPCCommand.connect:
            return handleConnect(request.payload)

        case IPCCommand.disconnect:
            return handleDisconnect(request.payload)

        default:
            return IPCResponse(success: false, message: "Unknown command '\(request.command)'", data: nil)
        }
    }

    // MARK: - App

    private func handleOpen() -> IPCResponse {
        NSApp.activate(ignoringOtherApps: true)
        return IPCResponse(success: true, message: "tmux-ide activated", data: nil)
    }

    // MARK: - Sessions

    private func handleListSessions() -> IPCResponse {
        let sessions = discoveryService.sessions
        var payload: [String: String] = [:]
        for session in sessions {
            payload[session.name] = session.name
        }
        return IPCResponse(success: true, message: "OK", data: payload)
    }

    private func handleFocusSession(_ payload: [String: String]) -> IPCResponse {
        guard let name = payload["session"], !name.isEmpty else {
            return IPCResponse(success: false, message: "Missing session name", data: nil)
        }

        let sessions = discoveryService.sessions
        let match = sessions.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }
            ?? sessions.first { $0.name.localizedCaseInsensitiveContains(name) }

        guard let match else {
            return IPCResponse(success: false, message: "No session matched '\(name)'", data: nil)
        }

        coordinator?.selectSession(match.name)
        NSApp.activate(ignoringOtherApps: true)
        return IPCResponse(success: true, message: "Focused '\(match.name)'", data: nil)
    }

    // MARK: - Session Lifecycle (delegated to command center)

    private func handleLaunch(_ payload: [String: String]) -> IPCResponse {
        guard let name = payload["session"], !name.isEmpty else {
            return IPCResponse(success: false, message: "Missing session name", data: nil)
        }
        guard let client = connectionManager.localClient else {
            return IPCResponse(success: false, message: "No local connection available", data: nil)
        }
        Task {
            _ = try? await client.launchSession(name: name)
        }
        return IPCResponse(success: true, message: "Launch requested for '\(name)'", data: nil)
    }

    private func handleStop(_ payload: [String: String]) -> IPCResponse {
        guard let name = payload["session"], !name.isEmpty else {
            return IPCResponse(success: false, message: "Missing session name", data: nil)
        }
        guard let client = connectionManager.localClient else {
            return IPCResponse(success: false, message: "No local connection available", data: nil)
        }
        Task {
            _ = try? await client.stopSession(name: name)
        }
        return IPCResponse(success: true, message: "Stop requested for '\(name)'", data: nil)
    }

    private func handleRestart(_ payload: [String: String]) -> IPCResponse {
        guard let name = payload["session"], !name.isEmpty else {
            return IPCResponse(success: false, message: "Missing session name", data: nil)
        }
        guard let client = connectionManager.localClient else {
            return IPCResponse(success: false, message: "No local connection available", data: nil)
        }
        Task {
            _ = try? await client.stopSession(name: name)
            try? await Task.sleep(for: .milliseconds(500))
            _ = try? await client.launchSession(name: name)
        }
        return IPCResponse(success: true, message: "Restart requested for '\(name)'", data: nil)
    }

    // MARK: - Pane Messaging

    private func handleSend(_ payload: [String: String]) -> IPCResponse {
        guard let session = payload["session"], !session.isEmpty else {
            return IPCResponse(success: false, message: "Missing session name", data: nil)
        }
        guard let target = payload["target"], !target.isEmpty else {
            return IPCResponse(success: false, message: "Missing target pane", data: nil)
        }
        guard let message = payload["message"] else {
            return IPCResponse(success: false, message: "Missing message", data: nil)
        }
        guard let client = connectionManager.localClient else {
            return IPCResponse(success: false, message: "No local connection available", data: nil)
        }
        let noEnter = parseBool(payload["noEnter"])
        Task {
            _ = try? await client.sendToPane(session: session, target: target, message: message, noEnter: noEnter)
        }
        return IPCResponse(success: true, message: "Message sent", data: nil)
    }

    // MARK: - Tiles

    private func handleAddTile(_ payload: [String: String]) -> IPCResponse {
        let tileType = payload["type"] ?? "terminal"
        coordinator?.performAction("add-\(tileType)")
        return IPCResponse(success: true, message: "Tile add requested", data: nil)
    }

    private func handleRemoveTile(_ payload: [String: String]) -> IPCResponse {
        // Tile removal requires canvas context — signal via pending action
        coordinator?.performAction("remove-tile")
        return IPCResponse(success: true, message: "Tile remove requested", data: nil)
    }

    // MARK: - Tasks (delegated to command center)

    private func handleTaskList(_ payload: [String: String]) -> IPCResponse {
        guard let client = connectionManager.localClient else {
            return IPCResponse(success: false, message: "No local connection available", data: nil)
        }
        let session = payload["session"] ?? coordinator?.selectedSession ?? ""
        guard !session.isEmpty else {
            return IPCResponse(success: false, message: "No active session", data: nil)
        }
        // Return immediately — caller can poll the command center REST API for task data
        return IPCResponse(success: true, message: "Use GET /api/project/\(session)/tasks", data: [
            "endpoint": client.target.baseURL.absoluteString
        ])
    }

    private func handleTaskCreate(_ payload: [String: String]) -> IPCResponse {
        return IPCResponse(success: true, message: "Use POST /api/project/:name/task via command center", data: nil)
    }

    private func handleTaskUpdate(_ payload: [String: String]) -> IPCResponse {
        return IPCResponse(success: true, message: "Use POST /api/project/:name/task/:id via command center", data: nil)
    }

    // MARK: - Orchestrator

    private func handleOrchestratorStatus(_ payload: [String: String]) -> IPCResponse {
        guard let client = connectionManager.localClient else {
            return IPCResponse(success: false, message: "No local connection available", data: nil)
        }
        let session = payload["session"] ?? coordinator?.selectedSession ?? ""
        return IPCResponse(success: true, message: "Use GET /api/project/\(session)/events", data: [
            "endpoint": client.target.baseURL.absoluteString
        ])
    }

    // MARK: - Connection Management

    private func handleConnect(_ payload: [String: String]) -> IPCResponse {
        guard let host = payload["host"], !host.isEmpty else {
            return IPCResponse(success: false, message: "Missing host", data: nil)
        }
        let port = Int(payload["port"] ?? "4000") ?? 4000
        let label = payload["label"] ?? host
        let method: ConnectionMethod
        switch payload["method"]?.lowercased() {
        case "ssh": method = .sshTunnel
        case "tailscale": method = .tailscale
        default: method = .directHTTP
        }
        let target = ConnectionTarget(label: label, host: host, port: port, connectionMethod: method)
        connectionManager.addTarget(target)
        return IPCResponse(success: true, message: "Connected to \(host):\(port)", data: nil)
    }

    private func handleDisconnect(_ payload: [String: String]) -> IPCResponse {
        guard let label = payload["label"], !label.isEmpty else {
            return IPCResponse(success: false, message: "Missing label", data: nil)
        }
        guard let target = connectionManager.targets.first(where: { $0.label == label }) else {
            return IPCResponse(success: false, message: "No connection '\(label)'", data: nil)
        }
        connectionManager.removeTarget(target)
        return IPCResponse(success: true, message: "Disconnected '\(label)'", data: nil)
    }

    // MARK: - Helpers

    private func parseBool(_ value: String?) -> Bool {
        guard let value else { return false }
        switch value.lowercased() {
        case "1", "true", "yes", "y": return true
        default: return false
        }
    }
}
