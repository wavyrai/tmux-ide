import Foundation
import Combine

/// Connects a Ghostty terminal surface to a tmux pane via the command-center
/// WebSocket mirror protocol.
///
/// The protocol works as follows:
/// - Client connects to `ws://host:port/ws/mirror/{session}/{paneId}`
/// - Server sends an initial JSON message: `{"type":"dimensions","cols":N,"rows":N}`
/// - All subsequent messages are raw terminal content (ANSI escape sequences)
/// - Client sends raw text back (user keyboard input), which the server forwards
///   to the tmux pane via `tmux send-keys`
///
/// MirrorTerminalController owns a GhosttyTerminalSurface that renders the received
/// terminal output. Keyboard input from the GhosttyNativeView is intercepted via
/// `onKeyInput` and sent over the WebSocket instead of to a local PTY.
@MainActor
final class MirrorTerminalController: NSObject, ObservableObject {
    @Published private(set) var isConnected = false
    @Published private(set) var connectionError: String?

    /// The Ghostty terminal surface used for rendering.
    /// Created lazily via `GhosttyAppHost.shared.makeSurface()`.
    private(set) var surface: GhosttyTerminalSurface?

    /// Pane dimensions received from the server (cols x rows).
    @Published private(set) var paneCols: Int = 80
    @Published private(set) var paneRows: Int = 24

    private var webSocketTask: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var receivedDimensions = false
    private var reconnectAttempts = 0
    private let maxReconnectAttempts = 5

    private var currentBaseURL: URL?
    private var currentSession: String?
    private var currentPaneId: String?

    override init() {
        super.init()
    }

    deinit {
        // Best-effort cancel (already on MainActor via deinit dispatch)
        webSocketTask?.cancel(with: .goingAway, reason: nil)
    }

    // MARK: - Public API

    /// Create the Ghostty surface for rendering terminal output.
    /// Must be called before connect().
    ///
    /// The surface runs a passthrough command (`stty raw -echo; exec cat`) instead
    /// of a local shell. This puts the PTY in raw mode with echo disabled, so ANSI
    /// data from the WebSocket flows cleanly through cat → PTY → terminal renderer
    /// without the PTY's line discipline interfering.
    func prepareSurface() {
        guard surface == nil else { return }
        surface = GhosttyAppHost.shared.makeSurface(
            sessionID: UUID(),
            workingDirectory: NSHomeDirectory(),
            shellPath: ""
        )

        // Use a passthrough command so the surface acts as a pure display.
        // stty raw -echo: disables PTY echo and line buffering
        // exec cat: reads stdin and writes to stdout (ANSI data round-trips through PTY)
        surface?.rawCommand = "stty raw -echo 2>/dev/null; exec cat"

        // Wire up the key input handler so keyboard events are routed
        // over the WebSocket instead of to a local PTY.
        surface?.view.onKeyInput = { [weak self] text in
            self?.sendInput(text)
        }
    }

    /// Connect to the tmux pane mirror WebSocket.
    ///
    /// - Parameters:
    ///   - baseURL: Command-center base URL (e.g. `http://localhost:4000`)
    ///   - session: tmux session name
    ///   - paneId: tmux pane ID (e.g. `%0`)
    func connect(baseURL: URL, session: String, paneId: String) {
        currentBaseURL = baseURL
        currentSession = session
        currentPaneId = paneId
        reconnectAttempts = 0

        performConnect(baseURL: baseURL, session: session, paneId: paneId)
    }

    /// Disconnect from the WebSocket and clean up.
    func disconnect() {
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        isConnected = false
        receivedDimensions = false
        reconnectAttempts = maxReconnectAttempts // Prevent auto-reconnect
    }

    /// Tear down the surface and all connections. Call when the view disappears.
    func tearDown() {
        disconnect()
        surface?.view.onKeyInput = nil
        surface?.destroy()
        surface = nil
    }

    // MARK: - Private

    private func performConnect(baseURL: URL, session: String, paneId: String) {
        // Build WebSocket URL: ws://host:port/ws/mirror/{session}/{paneId}
        // Use string construction instead of URLComponents to avoid double-encoding
        // the % in tmux pane IDs (e.g. %5092 would become %255092 with URLComponents.path)
        let scheme = baseURL.scheme == "https" ? "wss" : "ws"
        let host = baseURL.host ?? "localhost"
        let port = baseURL.port ?? 4000
        guard let wsURL = URL(string: "\(scheme)://\(host):\(port)/ws/mirror/\(session)/\(paneId)") else {
            connectionError = "Failed to construct WebSocket URL"
            return
        }

        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.urlSession = session

        let task = session.webSocketTask(with: wsURL)
        self.webSocketTask = task
        self.receivedDimensions = false
        self.connectionError = nil

        task.resume()
        receiveNextMessage()
    }

    private func receiveNextMessage() {
        webSocketTask?.receive { [weak self] result in
            Task { @MainActor in
                self?.handleReceiveResult(result)
            }
        }
    }

    private func handleReceiveResult(_ result: Result<URLSessionWebSocketTask.Message, Error>) {
        switch result {
        case .success(let message):
            handleMessage(message)
            receiveNextMessage()

        case .failure(let error):
            let nsError = error as NSError
            // Don't report cancellation as an error
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
                return
            }
            isConnected = false
            connectionError = error.localizedDescription
            attemptReconnect()
        }
    }

    private func handleMessage(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .string(let text):
            if !receivedDimensions && text.hasPrefix("{") {
                // First JSON message contains dimensions
                handleDimensionsMessage(text)
            } else {
                // Raw terminal content — feed into the Ghostty surface
                surface?.send(text: text)
            }

        case .data(let data):
            // Treat binary data as UTF-8 terminal content
            if let text = String(data: data, encoding: .utf8) {
                surface?.send(text: text)
            }

        @unknown default:
            break
        }
    }

    private func handleDimensionsMessage(_ json: String) {
        guard let data = json.data(using: .utf8) else { return }

        struct DimensionsMessage: Decodable {
            let type: String
            let cols: Int
            let rows: Int
        }

        guard let dims = try? JSONDecoder().decode(DimensionsMessage.self, from: data),
              dims.type == "dimensions" else {
            // Not a dimensions message — treat as terminal content
            surface?.send(text: json)
            return
        }

        receivedDimensions = true
        isConnected = true
        connectionError = nil
        reconnectAttempts = 0
        paneCols = dims.cols
        paneRows = dims.rows
    }

    /// Send user input text to the tmux pane via WebSocket.
    private func sendInput(_ text: String) {
        guard let task = webSocketTask, isConnected else { return }
        task.send(.string(text)) { error in
            if let error {
                Task { @MainActor in
                    self.connectionError = "Send failed: \(error.localizedDescription)"
                }
            }
        }
    }

    private func attemptReconnect() {
        guard reconnectAttempts < maxReconnectAttempts,
              let baseURL = currentBaseURL,
              let session = currentSession,
              let paneId = currentPaneId else { return }

        reconnectAttempts += 1
        let delay = Double(min(reconnectAttempts * reconnectAttempts, 16)) // Exponential backoff, max 16s

        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.reconnectAttempts <= self.maxReconnectAttempts else { return }
            self.performConnect(baseURL: baseURL, session: session, paneId: paneId)
        }
    }
}

// MARK: - URLSessionWebSocketDelegate

extension MirrorTerminalController: URLSessionWebSocketDelegate {
    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        Task { @MainActor in
            self.isConnected = true
            self.connectionError = nil
        }
    }

    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        Task { @MainActor in
            self.isConnected = false
            self.attemptReconnect()
        }
    }
}
