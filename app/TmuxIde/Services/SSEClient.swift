import Foundation

/// An actor that connects to the command-center SSE endpoint (`GET /api/events`)
/// and emits parsed `SSEEvent` values via an `AsyncStream`.
///
/// Handles the SSE text protocol:
/// - `event:` lines set the event type
/// - `data:` lines append to the data buffer
/// - `id:` lines set the last event ID
/// - Blank lines dispatch the accumulated event
///
/// Reconnects automatically with exponential backoff (1s → 2s → 4s → 8s → max 30s).
actor SSEClient {
    private let baseURL: URL
    private var urlSession: URLSession
    private var streamTask: Task<Void, Never>?
    private var lastEventId: String?

    private var continuation: AsyncStream<SSEEvent>.Continuation?
    private var _isConnected = false

    /// Whether the SSE stream is currently connected and receiving events.
    var isConnected: Bool { _isConnected }

    init(baseURL: URL) {
        self.baseURL = baseURL
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300 // Long-lived SSE connection
        config.timeoutIntervalForResource = 0  // No resource timeout
        self.urlSession = URLSession(configuration: config)
    }

    /// Returns an `AsyncStream` of parsed SSE events. Calling this starts the
    /// connection; the stream produces events until `disconnect()` is called.
    func events() -> AsyncStream<SSEEvent> {
        // Cancel any existing stream
        streamTask?.cancel()
        continuation?.finish()

        let (stream, continuation) = AsyncStream<SSEEvent>.makeStream()
        self.continuation = continuation

        streamTask = Task { [weak self] in
            guard let self else { return }
            await self.connectLoop()
        }

        return stream
    }

    /// Disconnect the SSE stream and stop reconnecting.
    func disconnect() {
        streamTask?.cancel()
        streamTask = nil
        continuation?.finish()
        continuation = nil
        _isConnected = false
    }

    // MARK: - Connection Loop

    private func connectLoop() async {
        var backoff: TimeInterval = 1.0
        let maxBackoff: TimeInterval = 30.0

        while !Task.isCancelled {
            do {
                try await connect()
                // If connect() returns normally (stream ended), reset backoff partially
                backoff = 1.0
            } catch is CancellationError {
                break
            } catch {
                _isConnected = false
            }

            guard !Task.isCancelled else { break }

            // Exponential backoff before reconnecting
            try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            backoff = min(backoff * 2, maxBackoff)
        }

        _isConnected = false
    }

    private func connect() async throws {
        var url = baseURL.appendingPathComponent("api/events")

        // Resume from last event ID if available
        if let lastId = lastEventId {
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            components.queryItems = [URLQueryItem(name: "lastEventId", value: lastId)]
            if let resumed = components.url {
                url = resumed
            }
        }

        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        if let lastId = lastEventId {
            request.setValue(lastId, forHTTPHeaderField: "Last-Event-ID")
        }

        let (bytes, response) = try await urlSession.bytes(for: request)

        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw SSEError.badStatus
        }

        _isConnected = true

        // Parse SSE line protocol
        var eventType: String?
        var dataBuffer = ""
        var eventId: String?

        for try await line in bytes.lines {
            if Task.isCancelled { break }

            if line.isEmpty {
                // Blank line = dispatch event
                if !dataBuffer.isEmpty {
                    if let event = parseEvent(type: eventType, data: dataBuffer) {
                        continuation?.yield(event)
                    }
                    if let id = eventId {
                        lastEventId = id
                    }
                }
                eventType = nil
                dataBuffer = ""
                eventId = nil
                continue
            }

            if line.hasPrefix(":") {
                // Comment line — ignore (used for keep-alive)
                continue
            }

            if line.hasPrefix("event:") {
                eventType = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                let value = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                if !dataBuffer.isEmpty {
                    dataBuffer += "\n"
                }
                dataBuffer += value
            } else if line.hasPrefix("id:") {
                eventId = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            }
            // Ignore "retry:" and unknown fields
        }

        // Stream ended normally (server closed)
        _isConnected = false
    }

    // MARK: - Event Parsing

    private func parseEvent(type: String?, data: String) -> SSEEvent? {
        guard let jsonData = data.data(using: .utf8) else { return nil }
        let decoder = JSONDecoder()

        switch type {
        case "session_added":
            guard let overview = try? decoder.decode(SessionOverview.self, from: jsonData) else { return nil }
            return .sessionAdded(overview)

        case "session_removed":
            guard let payload = try? decoder.decode(SessionRemovedPayload.self, from: jsonData) else { return nil }
            return .sessionRemoved(name: payload.name)

        case "session_update":
            guard let overview = try? decoder.decode(SessionOverview.self, from: jsonData) else { return nil }
            return .sessionUpdate(overview)

        case "task_update":
            guard let payload = try? decoder.decode(TaskUpdatePayload.self, from: jsonData) else { return nil }
            return .taskUpdate(payload)

        case "agent_status":
            guard let payload = try? decoder.decode(AgentStatusPayload.self, from: jsonData) else { return nil }
            return .agentStatus(payload)

        case "orchestrator_state":
            guard let payload = try? decoder.decode(OrchestratorStatePayload.self, from: jsonData) else { return nil }
            return .orchestratorState(payload)

        case "orchestrator_event":
            guard let payload = try? decoder.decode(OrchestratorEventPayload.self, from: jsonData) else { return nil }
            return .orchestratorEvent(payload)

        default:
            return nil
        }
    }
}

private enum SSEError: Error {
    case badStatus
}
