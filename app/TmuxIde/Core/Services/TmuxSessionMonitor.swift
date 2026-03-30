// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel
import Foundation
import Observation
import os.log

private let logger = Logger(subsystem: "dev.tmuxide.app", category: "TmuxSessionMonitor")

/// Monitors tmux sessions by polling `tmux list-sessions` and the command-center
/// REST API. Publishes an observable `sessions` dictionary that drives the status
/// bar menu and other UI.
@MainActor
@Observable
final class TmuxSessionMonitor {
    // MARK: - Singleton

    static let shared = TmuxSessionMonitor()

    // MARK: - Published State

    /// Keyed by session name.
    private(set) var sessions: [String: SessionInfo] = [:]

    /// Sum of agent panes across sessions (for tooltips / badges).
    var agentCount: Int {
        sessions.values.reduce(0) { $0 + $1.agentPanesTotal }
    }

    /// True when any agent pane is busy (drives menu bar “active” pulse).
    var hasBusyAgents: Bool {
        sessions.values.contains { $0.agentPanesBusy > 0 }
    }

    var taskProgress: (done: Int, total: Int) {
        let done = sessions.values.reduce(0) { $0 + $1.tasksDone }
        let total = sessions.values.reduce(0) { $0 + $1.tasksTotal }
        return (done, total)
    }

    /// True when any session has `orchestrator.enabled` in ide.yml (per command-center).
    var orchestratorStatus: Bool {
        sessions.values.contains { $0.orchestratorEnabled }
    }

    /// Aggregated orchestrator stats for all sessions where the orchestrator is enabled.
    var orchestratorAggregate: (
        dispatchMode: String,
        activeTasks: Int,
        queuedTasks: Int,
        stalledAgents: Int
    )? {
        let enabled = sessions.values.filter { $0.orchestratorEnabled }
        guard !enabled.isEmpty else { return nil }
        let mode = enabled.first?.dispatchMode ?? "tasks"
        let active = enabled.reduce(0) { $0 + $1.orchestratorTasksActive }
        let queued = enabled.reduce(0) { $0 + $1.orchestratorTasksQueued }
        let stalled = enabled.reduce(0) { $0 + $1.orchestratorStalledAgents }
        return (mode, active, queued, stalled)
    }

    // MARK: - Private

    private var pollTask: Task<Void, Never>?
    private let refreshInterval: Duration = .seconds(3)
    private var commandCenterPort: Int?

    private init() {}

    // MARK: - Lifecycle

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: self?.refreshInterval ?? .seconds(3))
            }
        }
        logger.info("Session monitor started")
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
        logger.info("Session monitor stopped")
    }

    /// Compatibility with VibeTunnel `SessionMonitor.getSessions()`.
    func getSessions() async -> [String: SessionInfo] {
        await refresh()
        return sessions
    }

    // MARK: - Refresh

    private func refresh() async {
        let tmuxSessions = Self.pollTmux()

        // Discover command-center port from tmux session variable
        for sess in tmuxSessions {
            if let port = Self.readCommandCenterPort(session: sess.name) {
                commandCenterPort = port
                break
            }
        }

        // Enrich with command-center data when available
        var enriched = tmuxSessions
        if let port = commandCenterPort {
            enriched = await Self.enrichFromCommandCenter(sessions: tmuxSessions, port: port)
        }

        // Detect lifecycle transitions
        let oldNames = Set(sessions.keys)
        let newNames = Set(enriched.map(\.name))

        for name in newNames.subtracting(oldNames) {
            logger.info("Session started: \(name)")
        }
        for name in oldNames.subtracting(newNames) {
            logger.info("Session ended: \(name)")
        }

        // Update published state
        var dict: [String: SessionInfo] = [:]
        for s in enriched { dict[s.name] = s }
        sessions = dict
    }

    // MARK: - tmux Polling

    private static func pollTmux() -> [SessionInfo] {
        let format = "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}"
        let output = runProcess("tmux", arguments: ["list-sessions", "-F", format])
        guard !output.isEmpty else { return [] }

        return output.split(separator: "\n").compactMap { line -> SessionInfo? in
            let parts = line.split(separator: "\t", maxSplits: 3)
            guard parts.count >= 4 else { return nil }

            let name = String(parts[0])
            let windows = Int(parts[1]) ?? 0
            let attached = parts[2] == "1"
            let createdEpoch = TimeInterval(parts[3]) ?? 0
            let created = Date(timeIntervalSince1970: createdEpoch)

            return SessionInfo(
                id: name,
                name: name,
                windowCount: windows,
                attached: attached,
                created: created,
                panes: [],
                agentPanesTotal: 0,
                agentPanesBusy: 0,
                missionTitle: nil,
                tasksDone: 0,
                tasksTotal: 0,
                orchestratorEnabled: false,
                dispatchMode: "tasks",
                orchestratorTasksActive: 0,
                orchestratorTasksQueued: 0,
                orchestratorStalledAgents: 0,
                orchestratorRunning: false,
                projectDirectory: nil,
                paneCount: windows
            )
        }
    }

    /// Read `@command_center_port` tmux session variable.
    private static func readCommandCenterPort(session: String) -> Int? {
        let output = runProcess("tmux", arguments: [
            "show-options", "-v", "-t", session, "@command_center_port",
        ])
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        return Int(trimmed)
    }

    // MARK: - Command Center Enrichment

    private static func enrichFromCommandCenter(
        sessions: [SessionInfo],
        port: Int
    ) async -> [SessionInfo] {
        let base = "http://127.0.0.1:\(port)"

        guard let overviewData = await httpGet("\(base)/api/sessions"),
              let overviewJson = try? JSONSerialization.jsonObject(with: overviewData) as? [String: Any],
              let sessionList = overviewJson["sessions"] as? [[String: Any]]
        else {
            return sessions
        }

        var enriched = sessions

        var apiSessions: [String: [String: Any]] = [:]
        for s in sessionList {
            if let name = s["name"] as? String {
                apiSessions[name] = s
            }
        }

        for i in enriched.indices {
            let name = enriched[i].name
            let pathName = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name

            if let api = apiSessions[name], let stats = api["stats"] as? [String: Any] {
                enriched[i].agentPanesTotal = stats["agents"] as? Int ?? 0
                enriched[i].agentPanesBusy = stats["activeAgents"] as? Int ?? 0
                enriched[i].tasksDone = stats["doneTasks"] as? Int ?? 0
                enriched[i].tasksTotal = stats["totalTasks"] as? Int ?? 0
            }

            if let detailData = await httpGet("\(base)/api/project/\(pathName)"),
               let detail = try? JSONSerialization.jsonObject(with: detailData) as? [String: Any]
            {
                enriched[i].projectDirectory = detail["dir"] as? String

                if let mission = detail["mission"] as? [String: Any] {
                    enriched[i].missionTitle = mission["title"] as? String
                }

                if let orchCfg = detail["orchestratorConfig"] as? [String: Any] {
                    enriched[i].orchestratorEnabled = orchCfg["enabled"] as? Bool ?? false
                    if let mode = orchCfg["dispatchMode"] as? String {
                        enriched[i].dispatchMode = mode
                    }
                }

                if let snap = detail["orchestratorSnapshot"] as? [String: Any] {
                    enriched[i].orchestratorTasksActive = snap["inProgressCount"] as? Int ?? 0
                    enriched[i].orchestratorTasksQueued = snap["pendingCount"] as? Int ?? 0
                    enriched[i].orchestratorRunning = snap["running"] as? Bool ?? false
                }

                if let paneData = await httpGet("\(base)/api/project/\(pathName)/panes"),
                   let paneJson = try? JSONSerialization.jsonObject(with: paneData) as? [String: Any],
                   let panes = paneJson["panes"] as? [[String: Any]]
                {
                    enriched[i].paneCount = panes.count
                } else {
                    enriched[i].paneCount = enriched[i].windowCount
                }
            }
        }

        return enriched
    }

    // MARK: - Helpers

    private static func runProcess(_ executable: String, arguments: [String]) -> String {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [executable] + arguments
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8) ?? ""
        } catch {
            return ""
        }
    }

    private static func httpGet(_ urlString: String) async -> Data? {
        guard let url = URL(string: urlString) else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return data
        } catch {
            return nil
        }
    }
}

/// Type alias so VibeTunnel-derived code that references `SessionMonitor` compiles.
typealias SessionMonitor = TmuxSessionMonitor
