import Foundation

enum ConnectionMethod: String, Codable, CaseIterable {
    case directHTTP = "direct"
    case sshTunnel = "ssh"
    case tailscale = "tailscale"

    var displayName: String {
        switch self {
        case .directHTTP: "Direct HTTP"
        case .sshTunnel: "SSH Tunnel"
        case .tailscale: "Tailscale"
        }
    }
}

struct ConnectionTarget: Codable, Identifiable, Hashable {
    let id: UUID
    var label: String
    var host: String
    var port: Int
    var connectionMethod: ConnectionMethod
    var isLocal: Bool

    var baseURL: URL {
        URL(string: "http://\(host):\(port)")!
    }

    init(
        id: UUID = UUID(),
        label: String,
        host: String = "localhost",
        port: Int = 4000,
        connectionMethod: ConnectionMethod = .directHTTP,
        isLocal: Bool = false
    ) {
        self.id = id
        self.label = label
        self.host = host
        self.port = port
        self.connectionMethod = connectionMethod
        self.isLocal = isLocal
    }

    static let localhost = ConnectionTarget(
        label: "Local",
        host: "localhost",
        port: 4000,
        connectionMethod: .directHTTP,
        isLocal: true
    )
}
