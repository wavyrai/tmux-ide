import Foundation

public enum IPCCommand {
    public static let open = "open"
    public static let listSessions = "listSessions"
    public static let focusSession = "focusSession"
    public static let launch = "launch"
    public static let stop = "stop"
    public static let restart = "restart"
    public static let send = "send"
    public static let addTile = "addTile"
    public static let removeTile = "removeTile"
    public static let taskList = "taskList"
    public static let taskCreate = "taskCreate"
    public static let taskUpdate = "taskUpdate"
    public static let orchestratorStatus = "orchestratorStatus"
    public static let connect = "connect"
    public static let disconnect = "disconnect"
}

public struct IPCRequest: Codable, Sendable {
    public let command: String
    public let payload: [String: String]

    public init(command: String, payload: [String: String] = [:]) {
        self.command = command
        self.payload = payload
    }
}

public struct IPCResponse: Codable, Sendable {
    public let success: Bool
    public let message: String?
    public let data: [String: String]?

    public init(success: Bool, message: String? = nil, data: [String: String]? = nil) {
        self.success = success
        self.message = message
        self.data = data
    }
}
