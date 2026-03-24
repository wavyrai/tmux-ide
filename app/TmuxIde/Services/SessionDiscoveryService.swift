import Foundation
import Combine

@MainActor
final class SessionDiscoveryService: ObservableObject {
    @Published private(set) var sessions: [SessionOverview] = []
    @Published private(set) var isConnected: Bool = false
    @Published private(set) var isSSEConnected: Bool = false
    @Published private(set) var lastError: String?

    /// Per-agent badge status keyed by "\(session):\(paneTitle)".
    @Published private(set) var agentStatuses: [String: AgentBadgeStatus] = [:]

    /// Recent orchestrator events (newest first, capped).
    @Published private(set) var activityFeed: [OrchestratorEventPayload] = []

    /// Latest orchestrator state snapshot per session.
    @Published private(set) var orchestratorSnapshots: [String: OrchestratorStatePayload] = [:]

    private let connectionManager: ConnectionManager
    private var pollTimer: Timer?
    private var cancellables = Set<AnyCancellable>()

    /// Fast polling (3s) — primary refresh when SSE is disconnected.
    private let normalPollInterval: TimeInterval = 3.0
    /// Slow polling (30s) — safety-net refresh when SSE is connected and handling real-time updates.
    private let sseFallbackPollInterval: TimeInterval = 30.0
    private let maxActivityFeedSize = 100

    // SSE per endpoint
    private var sseClients: [UUID: SSEClient] = [:]
    private var sseTasks: [UUID: Task<Void, Never>] = [:]

    init(connectionManager: ConnectionManager) {
        self.connectionManager = connectionManager

        // Sync aggregated sessions from ConnectionManager into flat list
        connectionManager.$aggregatedSessions
            .receive(on: DispatchQueue.main)
            .sink { [weak self] aggregated in
                self?.sessions = aggregated.map { $0.overview }
            }
            .store(in: &cancellables)

        // Derive connected state: at least one endpoint is reachable
        connectionManager.$health
            .receive(on: DispatchQueue.main)
            .sink { [weak self] health in
                self?.isConnected = health.values.contains(.reachable)
            }
            .store(in: &cancellables)
    }

    func start() {
        connectionManager.startMonitoring()
        startPolling(interval: normalPollInterval)
        startSSEForAllTargets()
        Task { await refresh() }
    }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
        connectionManager.stopMonitoring()
        stopAllSSE()
    }

    func refresh() async {
        await connectionManager.refreshAll()
    }

    /// Look up the badge status for a specific agent pane.
    func badgeStatus(session: String, paneTitle: String) -> AgentBadgeStatus? {
        agentStatuses["\(session):\(paneTitle)"]
    }

    // MARK: - Polling

    private func startPolling(interval: TimeInterval) {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in await self.refresh() }
        }
    }

    // MARK: - SSE

    private func startSSEForAllTargets() {
        for target in connectionManager.targets {
            startSSE(for: target)
        }
    }

    private func startSSE(for target: ConnectionTarget) {
        // Don't start duplicate
        guard sseClients[target.id] == nil else { return }

        let sse = SSEClient(baseURL: target.baseURL)
        sseClients[target.id] = sse

        sseTasks[target.id] = Task { [weak self] in
            let stream = await sse.events()
            for await event in stream {
                guard let self, !Task.isCancelled else { break }
                self.handleSSEEvent(event)

                // Update SSE connection status
                let connected = await sse.isConnected
                if connected != self.isSSEConnected {
                    self.isSSEConnected = connected
                    let interval = connected
                        ? self.sseFallbackPollInterval
                        : self.normalPollInterval
                    self.startPolling(interval: interval)
                }
            }
            // Stream ended — restore fast polling
            if let self = self {
                self.isSSEConnected = false
                self.startPolling(interval: self.normalPollInterval)
                self.sseClients.removeValue(forKey: target.id)
                self.sseTasks.removeValue(forKey: target.id)
            }
        }
    }

    private func stopAllSSE() {
        for (id, task) in sseTasks {
            task.cancel()
            Task { await sseClients[id]?.disconnect() }
        }
        sseTasks.removeAll()
        sseClients.removeAll()
        isSSEConnected = false
    }

    // MARK: - SSE Event Handling

    private func handleSSEEvent(_ event: SSEEvent) {
        switch event {
        case .sessionAdded(let overview):
            if !sessions.contains(where: { $0.name == overview.name }) {
                sessions.append(overview)
            }

        case .sessionRemoved(let name):
            sessions.removeAll { $0.name == name }
            agentStatuses = agentStatuses.filter { !$0.key.hasPrefix("\(name):") }
            orchestratorSnapshots.removeValue(forKey: name)

        case .sessionUpdate(let overview):
            if let idx = sessions.firstIndex(where: { $0.name == overview.name }) {
                sessions[idx] = overview
            }

        case .taskUpdate:
            // Task-level updates flow through orchestrator snapshots.
            // The UI can observe orchestratorSnapshots for task board refreshes.
            break

        case .agentStatus(let payload):
            let key = "\(payload.session):\(payload.agent)"
            agentStatuses[key] = payload.busy ? .busy : .idle

        case .orchestratorState(let payload):
            orchestratorSnapshots[payload.session] = payload

        case .orchestratorEvent(let payload):
            activityFeed.insert(payload, at: 0)
            if activityFeed.count > maxActivityFeedSize {
                activityFeed = Array(activityFeed.prefix(maxActivityFeedSize))
            }

            // Derive agent badge status from orchestrator events
            switch payload.type {
            case "error":
                if let agent = payload.agent {
                    agentStatuses["\(payload.session):\(agent)"] = .error
                }
            case "dispatch":
                if let agent = payload.agent {
                    agentStatuses["\(payload.session):\(agent)"] = .busy
                }
            case "completion":
                if let agent = payload.agent {
                    agentStatuses["\(payload.session):\(agent)"] = .idle
                }
            default:
                break
            }
        }
    }
}
