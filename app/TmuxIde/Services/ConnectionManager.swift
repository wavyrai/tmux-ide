import Foundation
import Combine

@MainActor
final class ConnectionManager: ObservableObject {

    // MARK: - Published State

    @Published private(set) var targets: [ConnectionTarget] = []
    @Published private(set) var health: [UUID: EndpointHealth] = [:]
    @Published private(set) var aggregatedSessions: [AggregatedSession] = []
    @Published private(set) var tailscaleAvailable: Bool = false
    @Published private(set) var tailscaleStatus: [UUID: TailscalePeerStatus] = [:]

    // MARK: - Types

    enum EndpointHealth: Equatable, Sendable {
        case unknown
        case reachable
        case unreachable
        case tailscalePeerOffline  // Tailscale peer found but offline
    }

    struct TailscalePeerStatus: Equatable, Sendable {
        let peerOnline: Bool
        let resolvedIP: String?
    }

    struct AggregatedSession: Identifiable, Sendable {
        var id: String { qualifiedName }
        let qualifiedName: String   // "Label / session" for remote, "session" for local
        let rawName: String
        let endpointID: UUID
        let endpointLabel: String
        let overview: SessionOverview
    }

    // MARK: - SSH Tunnels

    let sshTunnelService = SSHTunnelService()

    // MARK: - Bonjour

    let bonjourBrowser = BonjourBrowser()
    private var bonjourObserver: AnyCancellable?

    // MARK: - Private

    private var clients: [UUID: CommandCenterClient] = [:]
    private var resolvedHosts: [UUID: String] = [:]  // Tailscale resolved IPs
    private let connectionsFileURL: URL
    private var healthTimer: Timer?
    private let healthInterval: TimeInterval = 5.0

    // MARK: - Init

    init(connectionsFile: URL) {
        self.connectionsFileURL = connectionsFile
        loadTargets()
        ensureLocalTarget()

        // Check Tailscale CLI availability on init
        Task { tailscaleAvailable = await TailscaleService.isCLIAvailable() }

        // Start Bonjour discovery
        bonjourBrowser.start()
    }

    // MARK: - Persistence

    private func loadTargets() {
        guard FileManager.default.fileExists(atPath: connectionsFileURL.path) else { return }
        do {
            let data = try Data(contentsOf: connectionsFileURL)
            targets = try JSONDecoder().decode([ConnectionTarget].self, from: data)
        } catch {
            targets = []
        }
    }

    private func saveTargets() {
        do {
            let data = try JSONEncoder().encode(targets)
            try data.write(to: connectionsFileURL, options: .atomic)
        } catch {
            // Best-effort persistence
        }
    }

    private func ensureLocalTarget() {
        if !targets.contains(where: { $0.isLocal }) {
            targets.insert(.localhost, at: 0)
            saveTargets()
        }
    }

    // MARK: - Target Management

    func addTarget(_ target: ConnectionTarget) {
        targets.append(target)
        saveTargets()
        Task {
            await resolveAndBuildClient(for: target)
            await checkHealth(for: target)
        }
    }

    /// Add a Bonjour-discovered service as a connection target.
    func addFromBonjour(_ service: BonjourService) {
        guard !targets.contains(where: { $0.host == service.host && $0.port == service.port }) else { return }
        let target = ConnectionTarget(
            label: service.name,
            host: service.host,
            port: service.port,
            connectionMethod: .directHTTP
        )
        addTarget(target)
    }

    func removeTarget(_ target: ConnectionTarget) {
        guard !target.isLocal else { return }
        sshTunnelService.closeTunnel(for: target.id)
        targets.removeAll { $0.id == target.id }
        clients.removeValue(forKey: target.id)
        health.removeValue(forKey: target.id)
        tailscaleStatus.removeValue(forKey: target.id)
        resolvedHosts.removeValue(forKey: target.id)
        saveTargets()
        rebuildAggregatedSessions()
    }

    func updateTarget(_ target: ConnectionTarget) {
        guard let idx = targets.firstIndex(where: { $0.id == target.id }) else { return }
        targets[idx] = target
        saveTargets()
        Task {
            await resolveAndBuildClient(for: target)
            await checkHealth(for: target)
        }
    }

    // MARK: - Client Access

    func client(for targetID: UUID) -> CommandCenterClient? {
        if let existing = clients[targetID] { return existing }
        guard let target = targets.first(where: { $0.id == targetID }) else { return nil }
        let effectiveTarget = resolvedTarget(for: target)
        let client = CommandCenterClient(target: effectiveTarget)
        clients[targetID] = client
        return client
    }

    /// Returns the client for the local endpoint.
    var localClient: CommandCenterClient? {
        guard let local = targets.first(where: { $0.isLocal }) else { return nil }
        return client(for: local.id)
    }

    // MARK: - Target Resolution

    /// Resolve and build client for a target. Handles Tailscale DNS and SSH tunnels.
    private func resolveAndBuildClient(for target: ConnectionTarget) async {
        switch target.connectionMethod {
        case .tailscale:
            let resolved = await TailscaleService.resolveHost(target.host)
            resolvedHosts[target.id] = resolved

        case .sshTunnel:
            // Start SSH tunnel — this spawns the ssh process and returns the local port
            sshTunnelService.openTunnel(for: target)

        case .directHTTP:
            break
        }

        let effectiveTarget = resolvedTarget(for: target)
        clients[target.id] = CommandCenterClient(target: effectiveTarget)
    }

    /// Build an effective target, accounting for Tailscale resolution and SSH tunnels.
    private func resolvedTarget(for target: ConnectionTarget) -> ConnectionTarget {
        switch target.connectionMethod {
        case .tailscale:
            guard let resolvedIP = resolvedHosts[target.id] else { return target }
            return ConnectionTarget(
                id: target.id,
                label: target.label,
                host: resolvedIP,
                port: target.port,
                connectionMethod: target.connectionMethod,
                isLocal: target.isLocal
            )

        case .sshTunnel:
            guard let localPort = sshTunnelService.localPort(for: target.id) else { return target }
            return ConnectionTarget(
                id: target.id,
                label: target.label,
                host: "localhost",
                port: localPort,
                connectionMethod: .directHTTP,
                isLocal: false
            )

        case .directHTTP:
            return target
        }
    }

    /// Returns the effective base URL for a target, accounting for SSH tunnels and Tailscale.
    func effectiveBaseURL(for targetID: UUID) -> URL? {
        guard let target = targets.first(where: { $0.id == targetID }) else { return nil }
        return resolvedTarget(for: target).baseURL
    }

    // MARK: - Health Monitoring

    func startMonitoring() {
        // Resolve Tailscale targets and ensure all clients exist
        Task {
            for target in targets {
                await resolveAndBuildClient(for: target)
            }
        }

        healthTimer?.invalidate()
        healthTimer = Timer.scheduledTimer(withTimeInterval: healthInterval, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in await self.refreshAll() }
        }
        Task { await refreshAll() }
    }

    func stopMonitoring() {
        healthTimer?.invalidate()
        healthTimer = nil
        sshTunnelService.closeAll()
        bonjourBrowser.stop()
    }

    func refreshAll() async {
        // Refresh Tailscale CLI availability
        tailscaleAvailable = await TailscaleService.isCLIAvailable()

        // Collect clients before entering task group to avoid @MainActor isolation issues
        let checks: [(id: UUID, target: ConnectionTarget, client: CommandCenterClient)] = targets.compactMap { target in
            guard let c = client(for: target.id) else { return nil }
            return (target.id, target, c)
        }

        let results = await withTaskGroup(of: (UUID, Bool, TailscalePeerStatus?).self) { group in
            for check in checks {
                group.addTask {
                    let reachable = await check.client.isReachable()

                    // For Tailscale targets, also check peer status
                    var peerStatus: TailscalePeerStatus?
                    if check.target.connectionMethod == .tailscale {
                        let online = await TailscaleService.isPeerOnline(check.target.host)
                        let ip = await TailscaleService.resolveHost(check.target.host)
                        peerStatus = TailscalePeerStatus(peerOnline: online, resolvedIP: ip)
                    }

                    return (check.id, reachable, peerStatus)
                }
            }
            var collected: [(UUID, Bool, TailscalePeerStatus?)] = []
            for await result in group {
                collected.append(result)
            }
            return collected
        }

        for (id, reachable, peerStatus) in results {
            if let peerStatus {
                tailscaleStatus[id] = peerStatus
                if !peerStatus.peerOnline {
                    health[id] = .tailscalePeerOffline
                } else {
                    health[id] = reachable ? .reachable : .unreachable
                }
                // Update resolved IP if it changed
                if let ip = peerStatus.resolvedIP {
                    let target = targets.first { $0.id == id }
                    if resolvedHosts[id] != ip {
                        resolvedHosts[id] = ip
                        if let target {
                            let effectiveTarget = resolvedTarget(for: target)
                            clients[id] = CommandCenterClient(target: effectiveTarget)
                        }
                    }
                }
            } else {
                health[id] = reachable ? .reachable : .unreachable
            }
        }

        // Mark targets without clients as unreachable
        for target in targets where !results.contains(where: { $0.0 == target.id }) {
            health[target.id] = .unreachable
        }

        await fetchAllSessions()
    }

    private func checkHealth(for target: ConnectionTarget) async {
        guard let client = client(for: target.id) else {
            health[target.id] = .unreachable
            return
        }

        // Tailscale: check peer status first
        if target.connectionMethod == .tailscale {
            let online = await TailscaleService.isPeerOnline(target.host)
            let ip = await TailscaleService.resolveHost(target.host)
            tailscaleStatus[target.id] = TailscalePeerStatus(peerOnline: online, resolvedIP: ip)
            if !online {
                health[target.id] = .tailscalePeerOffline
                return
            }
        }

        let reachable = await client.isReachable()
        health[target.id] = reachable ? .reachable : .unreachable
    }

    // MARK: - Session Aggregation

    private func fetchAllSessions() async {
        var all: [AggregatedSession] = []

        for target in targets {
            guard health[target.id] == .reachable,
                  let client = clients[target.id] else { continue }

            do {
                let sessions = try await client.fetchSessions()
                for session in sessions {
                    let qualified = target.isLocal
                        ? session.name
                        : "\(target.label) / \(session.name)"
                    all.append(AggregatedSession(
                        qualifiedName: qualified,
                        rawName: session.name,
                        endpointID: target.id,
                        endpointLabel: target.label,
                        overview: session
                    ))
                }
            } catch {
                // Skip this endpoint on failure
            }
        }

        aggregatedSessions = all
    }

    private func rebuildAggregatedSessions() {
        aggregatedSessions = aggregatedSessions.filter { session in
            targets.contains { $0.id == session.endpointID }
        }
    }
}
