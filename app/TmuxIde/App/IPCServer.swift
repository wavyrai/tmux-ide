import Darwin
import Foundation

/// Unix domain socket server for local IPC.
///
/// Listens on a socket file (e.g. `~/Library/Application Support/tmux-ide-app/run/tmux-ide.sock`)
/// and dispatches JSON-encoded `IPCRequest` messages to a handler, returning `IPCResponse`.
///
/// All mutable state is accessed from the internal serial queue. `start()` and `stop()`
/// are called from the app coordinator on the main actor.
final class IPCServer: @unchecked Sendable {
    private let socketPath: String
    private let handler: (IPCRequest) -> IPCResponse
    private let queue = DispatchQueue(label: "tmux-ide.ipc.server", qos: .userInitiated)

    private var listeningFD: Int32 = -1
    private var isRunning = false

    init(socketPath: String, handler: @escaping (IPCRequest) -> IPCResponse) {
        self.socketPath = socketPath
        self.handler = handler
    }

    func start() {
        queue.async { [weak self] in
            self?.runLoop()
        }
    }

    func stop() {
        isRunning = false
        if listeningFD >= 0 {
            close(listeningFD)
            listeningFD = -1
        }
        unlink(socketPath)
    }

    private func runLoop() {
        guard !isRunning else { return }
        isRunning = true

        _ = FileManager.default.createFile(atPath: socketPath, contents: nil)
        unlink(socketPath)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            isRunning = false
            return
        }
        listeningFD = fd

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)

        let pathBytes = Array(socketPath.utf8)
        let maxPathLength = MemoryLayout.size(ofValue: addr.sun_path)
        guard pathBytes.count < maxPathLength else {
            close(fd)
            listeningFD = -1
            isRunning = false
            return
        }

        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            let raw = UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: CChar.self)
            raw.initialize(repeating: 0, count: maxPathLength)
            for index in pathBytes.indices {
                raw[index] = CChar(bitPattern: pathBytes[index])
            }
        }

        let addrLength = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count + 1)
        let bindResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, addrLength)
            }
        }

        guard bindResult == 0 else {
            close(fd)
            listeningFD = -1
            isRunning = false
            unlink(socketPath)
            return
        }

        chmod(socketPath, 0o600)

        guard listen(fd, 8) == 0 else {
            close(fd)
            listeningFD = -1
            isRunning = false
            unlink(socketPath)
            return
        }

        while isRunning {
            let clientFD = accept(fd, nil, nil)
            if clientFD < 0 {
                if errno == EINTR {
                    continue
                }
                break
            }

            handleClient(fd: clientFD)
            close(clientFD)
        }

        close(fd)
        listeningFD = -1
        unlink(socketPath)
        isRunning = false
    }

    private func handleClient(fd: Int32) {
        var requestBuffer = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)

        while true {
            let count = read(fd, &chunk, chunk.count)
            if count > 0 {
                requestBuffer.append(contentsOf: chunk.prefix(Int(count)))
                continue
            }
            break
        }

        let response: IPCResponse
        do {
            let request = try JSONDecoder().decode(IPCRequest.self, from: requestBuffer)
            response = handler(request)
        } catch {
            response = IPCResponse(success: false, message: "Invalid IPC request: \(error.localizedDescription)", data: nil)
        }

        do {
            let data = try JSONEncoder().encode(response)
            _ = data.withUnsafeBytes { bytes in
                write(fd, bytes.baseAddress, bytes.count)
            }
        } catch {
            let fallback = "{\"success\":false,\"message\":\"Failed to encode IPC response\",\"data\":null}"
            _ = fallback.withCString { ptr in
                write(fd, ptr, strlen(ptr))
            }
        }
    }
}
