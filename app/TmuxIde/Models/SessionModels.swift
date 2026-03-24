import Foundation

// Matches the command-center REST API response shapes

struct SessionStats: Codable {
    let totalTasks: Int
    let doneTasks: Int
    let agents: Int
    let activeAgents: Int
}

struct GoalProgress: Codable {
    let id: String
    let title: String
    let progress: Int
}

struct Mission: Codable {
    let title: String
    let description: String
    let created: String
    let updated: String
}

struct SessionOverview: Codable, Identifiable {
    var id: String { name }
    let name: String
    let dir: String
    let mission: Mission?
    let stats: SessionStats
    let goals: [GoalProgress]
}

struct SessionsResponse: Codable {
    let sessions: [SessionOverview]
}

struct TmuxIdePane: Codable, Identifiable {
    let id: String
    let index: Int
    let title: String
    let currentCommand: String
    let width: Int
    let height: Int
    let active: Bool
    let role: String?
    let name: String?
    let type: String?
}

struct PanesResponse: Codable {
    let panes: [TmuxIdePane]
}

struct AgentDetail: Codable {
    let paneTitle: String
    let paneId: String
    let isBusy: Bool
    let taskTitle: String?
    let taskId: String?
    let elapsed: String
}

struct ProjectDetail: Codable {
    let session: String
    let dir: String
    let mission: Mission?
    let goals: [Goal]
    let tasks: [TaskItem]
    let agents: [AgentDetail]
}

struct Goal: Codable, Identifiable {
    let id: String
    let title: String
    let description: String
    let status: String
    let acceptance: String
    let priority: Int
}

struct TaskItem: Codable, Identifiable {
    let id: String
    let title: String
    let description: String
    let goal: String?
    let status: String
    let assignee: String?
    let priority: Int
    let tags: [String]
}

// MARK: - SSE Event Types

/// A parsed Server-Sent Event from the command-center /api/events stream.
enum SSEEvent {
    case sessionAdded(SessionOverview)
    case sessionRemoved(name: String)
    case sessionUpdate(SessionOverview)
    case taskUpdate(TaskUpdatePayload)
    case agentStatus(AgentStatusPayload)
    case orchestratorState(OrchestratorStatePayload)
    case orchestratorEvent(OrchestratorEventPayload)
}

struct TaskUpdatePayload: Codable {
    let session: String
    let taskId: String
    let status: String?
    let assignee: String?
    let title: String?
}

struct AgentStatusPayload: Codable {
    let session: String
    let agent: String
    let busy: Bool
    let taskId: String?
}

struct OrchestratorStatePayload: Codable {
    let session: String
    let agents: [AgentDetail]?
    let tasks: [TaskItem]?
    let goals: [Goal]?
}

struct OrchestratorEventPayload: Codable {
    let session: String
    let timestamp: String
    let type: String
    let taskId: String?
    let agent: String?
    let message: String?
    let branch: String?
    let durationMs: Int?
    let elapsedMs: Int?
}

struct SessionRemovedPayload: Codable {
    let name: String
}

/// Agent status for UI badge rendering on terminal tiles.
enum AgentBadgeStatus: Equatable {
    case idle
    case busy
    case error
}
