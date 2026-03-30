// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel
import Foundation
import Observation

/// Lightweight shim that satisfies VibeTunnel-derived views expecting a `ServerManager`.
///
/// In tmux-ide the "server" is the daemon + command-center HTTP process managed
/// by the CLI, so this class simply polls for its existence via the command-center
/// port stored in tmux session variables.
@MainActor
@Observable
final class ServerManager {
    static let shared = ServerManager()

    private(set) var isRunning = false
    /// Writable from settings (e.g. port change) — daemon lifecycle is still owned by the CLI.
    var port: String = "4000"
    private(set) var bindAddress: String = "127.0.0.1"

    /// Authentication mode for HTTP / WS clients (`"none"`, `"ssh"`, etc.).
    var authMode: String = "none"

    /// Optional header token when the command center expects local auth.
    var localAuthToken: String?

    private var pollTask: Task<Void, Never>?

    private init() {}

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                self?.pollDaemon()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func pollDaemon() {
        // Try to find the command center port from any running tmux-ide session
        let output = Self.runProcess("tmux", arguments: [
            "list-sessions", "-F", "#{session_name}",
        ])
        guard !output.isEmpty else {
            isRunning = false
            return
        }

        let sessions = output.split(separator: "\n").map(String.init)
        for session in sessions {
            let portOutput = Self.runProcess("tmux", arguments: [
                "show-options", "-v", "-t", session, "@command_center_port",
            ]).trimmingCharacters(in: .whitespacesAndNewlines)
            if let p = Int(portOutput), p > 0 {
                port = String(p)
                isRunning = true
                return
            }
        }
        isRunning = false
    }

    /// Build a URL from the command-center base (legacy name).
    func buildURL(path: String) -> URL? {
        buildURL(endpoint: path, queryItems: [])
    }

    /// Build a URL with optional query items.
    func buildURL(endpoint: String, queryItems: [URLQueryItem] = []) -> URL? {
        let path = endpoint.hasPrefix("/") ? endpoint : "/\(endpoint)"
        var components = URLComponents()
        components.scheme = "http"
        let host = bindAddress == "0.0.0.0" ? "127.0.0.1" : bindAddress
        components.host = host
        components.port = Int(port)
        components.path = path
        if !queryItems.isEmpty {
            components.queryItems = queryItems
        }
        return components.url
    }

    func performRequest<T: Decodable>(
        endpoint: String,
        method: String = "GET",
        queryItems: [URLQueryItem] = [],
        responseType: T.Type,
    ) async throws -> T {
        guard let url = buildURL(endpoint: endpoint, queryItems: queryItems) else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = localAuthToken {
            request.setValue(token, forHTTPHeaderField: NetworkConstants.localAuthHeader)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func performVoidRequest(
        endpoint: String,
        method: String,
        queryItems: [URLQueryItem] = [],
    ) async throws {
        guard let url = buildURL(endpoint: endpoint, queryItems: queryItems) else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let token = localAuthToken {
            request.setValue(token, forHTTPHeaderField: NetworkConstants.localAuthHeader)
        }
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
    }

    func performVoidRequest<E: Encodable>(
        endpoint: String,
        method: String,
        body: E,
        queryItems: [URLQueryItem] = [],
    ) async throws {
        guard let url = buildURL(endpoint: endpoint, queryItems: queryItems) else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        if let token = localAuthToken {
            request.setValue(token, forHTTPHeaderField: NetworkConstants.localAuthHeader)
        }
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
    }

    func restart() {
        // Restart is a no-op in the shim — the CLI owns the daemon lifecycle.
    }

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
}

/// Alias matching integration docs (`DaemonManager` = command-center / daemon status).
typealias DaemonManager = ServerManager
