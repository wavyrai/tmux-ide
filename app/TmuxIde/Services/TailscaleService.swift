import Foundation

/// Interacts with the `tailscale` CLI to resolve hostnames and check peer status.
/// Tailscale provides direct encrypted connectivity — no tunnel needed.
enum TailscaleService {

    // MARK: - CLI Availability

    /// Whether the `tailscale` CLI is installed and reachable.
    static func isCLIAvailable() async -> Bool {
        do {
            let result = try await run(["tailscale", "version"])
            return result.exitCode == 0
        } catch {
            return false
        }
    }

    // MARK: - Status

    /// Parsed Tailscale status, containing self node and peer list.
    struct Status: Sendable {
        let selfNodeIP: String?
        let peers: [Peer]
    }

    struct Peer: Sendable {
        let hostname: String
        let dnsName: String
        let tailscaleIPs: [String]
        let online: Bool
    }

    /// Fetch full Tailscale network status via `tailscale status --json`.
    static func fetchStatus() async -> Status? {
        do {
            let result = try await run(["tailscale", "status", "--json"])
            guard result.exitCode == 0, let data = result.stdout.data(using: .utf8) else { return nil }
            return parseStatus(data)
        } catch {
            return nil
        }
    }

    /// Resolve a Tailscale hostname or DNS name to its first IP address.
    /// Accepts formats: "hostname", "hostname.tail12345.ts.net", raw IP passthrough.
    static func resolveHost(_ host: String) async -> String? {
        guard let status = await fetchStatus() else { return nil }
        return findIP(for: host, in: status)
    }

    /// Check whether a Tailscale peer identified by hostname is currently online.
    static func isPeerOnline(_ host: String) async -> Bool {
        guard let status = await fetchStatus() else { return false }
        return findPeer(for: host, in: status)?.online ?? false
    }

    // MARK: - Parsing

    private static func parseStatus(_ data: Data) -> Status? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }

        // Self node IP
        let selfNode = json["Self"] as? [String: Any]
        let selfIPs = selfNode?["TailscaleIPs"] as? [String]
        let selfIP = selfIPs?.first

        // Peer map
        var peers: [Peer] = []
        if let peerMap = json["Peer"] as? [String: [String: Any]] {
            for (_, peerInfo) in peerMap {
                let hostname = peerInfo["HostName"] as? String ?? ""
                let dnsName = peerInfo["DNSName"] as? String ?? ""
                let ips = peerInfo["TailscaleIPs"] as? [String] ?? []
                let online = peerInfo["Online"] as? Bool ?? false
                peers.append(Peer(
                    hostname: hostname,
                    dnsName: dnsName,
                    tailscaleIPs: ips,
                    online: online
                ))
            }
        }

        return Status(selfNodeIP: selfIP, peers: peers)
    }

    private static func findPeer(for host: String, in status: Status) -> Peer? {
        let lowered = host.lowercased()
        return status.peers.first { peer in
            peer.hostname.lowercased() == lowered
                || peer.dnsName.lowercased().hasPrefix(lowered)
                || peer.dnsName.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")) == lowered
                || peer.tailscaleIPs.contains(host)
        }
    }

    private static func findIP(for host: String, in status: Status) -> String? {
        // If it's already an IP, pass through
        if host.contains(where: \.isNumber), !host.contains(where: \.isLetter) {
            return host
        }
        return findPeer(for: host, in: status)?.tailscaleIPs.first
    }

    // MARK: - Process Execution

    private struct ProcessResult: Sendable {
        let stdout: String
        let exitCode: Int32
    }

    private static func run(_ arguments: [String]) async throws -> ProcessResult {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                let process = Process()
                let pipe = Pipe()

                process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                process.arguments = arguments
                process.standardOutput = pipe
                process.standardError = FileHandle.nullDevice

                do {
                    try process.run()
                    process.waitUntilExit()
                    let data = pipe.fileHandleForReading.readDataToEndOfFile()
                    let output = String(data: data, encoding: .utf8) ?? ""
                    continuation.resume(returning: ProcessResult(stdout: output, exitCode: process.terminationStatus))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}
