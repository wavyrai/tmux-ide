import Foundation
import Network

/// Discovered tmux-ide service on the local network via Bonjour/mDNS.
struct BonjourService: Identifiable, Equatable, Hashable {
    let id: String  // NWEndpoint description
    let name: String
    let host: String
    let port: Int
}

/// Browses for `_tmux-ide._tcp` Bonjour services on the local network.
/// Discovered services auto-appear in the connection list.
@MainActor
final class BonjourBrowser: ObservableObject {

    @Published private(set) var services: [BonjourService] = []

    private var browser: NWBrowser?
    private var resolving: [NWConnection] = []

    static let serviceType = "_tmux-ide._tcp"

    // MARK: - Start / Stop

    func start() {
        let params = NWParameters()
        params.includePeerToPeer = true

        let descriptor = NWBrowser.Descriptor.bonjour(type: Self.serviceType, domain: nil)
        let newBrowser = NWBrowser(for: descriptor, using: params)

        newBrowser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor [weak self] in
                self?.handleResults(results)
            }
        }

        newBrowser.stateUpdateHandler = { state in
            switch state {
            case .failed:
                // Restart on failure after a short delay
                Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    self?.start()
                }
            default:
                break
            }
        }

        newBrowser.start(queue: .main)
        browser = newBrowser
    }

    func stop() {
        browser?.cancel()
        browser = nil
        for conn in resolving { conn.cancel() }
        resolving = []
    }

    // MARK: - Result Handling

    private func handleResults(_ results: Set<NWBrowser.Result>) {
        // Resolve each result's endpoint to get host:port
        for result in results {
            resolveEndpoint(result.endpoint, name: extractName(from: result))
        }
    }

    private func extractName(from result: NWBrowser.Result) -> String {
        if case .service(let name, _, _, _) = result.endpoint {
            return name
        }
        return "tmux-ide"
    }

    private func resolveEndpoint(_ endpoint: NWEndpoint, name: String) {
        let connection = NWConnection(to: endpoint, using: .tcp)
        resolving.append(connection)

        connection.stateUpdateHandler = { [weak self] state in
            Task { @MainActor [weak self] in
                guard let self else { return }

                switch state {
                case .ready:
                    if let resolved = self.extractHostPort(from: connection) {
                        let service = BonjourService(
                            id: endpoint.debugDescription,
                            name: name,
                            host: resolved.host,
                            port: resolved.port
                        )
                        if !self.services.contains(where: { $0.id == service.id }) {
                            self.services.append(service)
                        }
                    }
                    connection.cancel()
                    self.resolving.removeAll { $0 === connection }

                case .failed, .cancelled:
                    self.resolving.removeAll { $0 === connection }

                default:
                    break
                }
            }
        }

        connection.start(queue: .main)

        // Timeout: cancel after 5 seconds if not resolved
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if self?.resolving.contains(where: { $0 === connection }) == true {
                connection.cancel()
                self?.resolving.removeAll { $0 === connection }
            }
        }
    }

    private func extractHostPort(from connection: NWConnection) -> (host: String, port: Int)? {
        guard let endpoint = connection.currentPath?.remoteEndpoint else { return nil }
        switch endpoint {
        case .hostPort(let host, let port):
            let hostStr: String
            switch host {
            case .ipv4(let addr):
                hostStr = "\(addr)"
            case .ipv6(let addr):
                hostStr = "\(addr)"
            case .name(let name, _):
                hostStr = name
            @unknown default:
                hostStr = "\(host)"
            }
            return (hostStr, Int(port.rawValue))
        default:
            return nil
        }
    }

    // MARK: - Bonjour Advertising (for command-center)

    /// Advertise a tmux-ide command-center on the local network.
    /// Call from the command-center server process.
    static func advertise(port: UInt16) -> NWListener? {
        do {
            let listener = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!)
            listener.service = NWListener.Service(
                name: Host.current().localizedName ?? "tmux-ide",
                type: serviceType
            )
            listener.stateUpdateHandler = { _ in }
            listener.newConnectionHandler = { connection in
                // We don't actually accept connections here — the real server handles them.
                // This listener exists solely for Bonjour advertisement.
                connection.cancel()
            }
            listener.start(queue: .global(qos: .utility))
            return listener
        } catch {
            return nil
        }
    }
}
