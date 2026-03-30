// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel
import Foundation

/// Information about a tmux session, combining tmux list-sessions data
/// with richer command-center REST API data when the daemon is running.
struct SessionInfo: Identifiable, Sendable {
    let id: String       // session name (tmux session_name)
    let name: String
    var windowCount: Int
    var attached: Bool
    var created: Date
    var panes: [PaneInfo]
    /// Total agent-role panes (from command-center stats).
    var agentPanesTotal: Int
    /// Agent panes currently busy (spinners / active work).
    var agentPanesBusy: Int
    var missionTitle: String?
    var tasksDone: Int
    var tasksTotal: Int
    /// True when ide.yml enables the orchestrator block (from command-center).
    var orchestratorEnabled: Bool
    /// `tasks` or `goals` from ide.yml when orchestrator is configured.
    var dispatchMode: String
    /// In-progress tasks (orchestrator snapshot).
    var orchestratorTasksActive: Int
    /// Queued todo tasks (orchestrator snapshot).
    var orchestratorTasksQueued: Int
    /// Best-effort stall count (0 when not available from API).
    var orchestratorStalledAgents: Int
    /// Legacy: daemon reported orchestrator loop active (optional signal).
    var orchestratorRunning: Bool
    /// Project root path from command-center (`/api/project/:name`), for CLI actions.
    var projectDirectory: String?
    /// Total tmux panes (from `/api/project/:name/panes` when available).
    var paneCount: Int

    /// Process id for window matching (optional).
    var pid: Int? = nil
    /// Working directory hint for window/title matching.
    var workingDir: String = ""
    /// Lifecycle status for window tracking (`"running"`, `"exited"`, …).
    var status: String = "running"

    /// True when the session is alive in tmux.
    var isRunning: Bool { status != "exited" }

    /// True when there is at least one attached client.
    var isActivityActive: Bool { attached }

    /// Alias used by VibeTunnel-derived status bar code.
    var startedAt: Date { created }

    /// Backward-compatible: historically meant “agents shown in compact UI”.
    var agentCount: Int { agentPanesTotal }

    var agentPanesIdle: Int { max(0, agentPanesTotal - agentPanesBusy) }
}

/// Minimal pane metadata from tmux or the command-center API.
struct PaneInfo: Identifiable, Sendable {
    let id: String       // tmux pane_id (%N)
    var title: String
    var currentCommand: String?
    var role: String?
    var isBusy: Bool
}

/// Type alias so VibeTunnel-derived code that references `ServerSessionInfo`
/// continue to compile without changes.
typealias ServerSessionInfo = SessionInfo
