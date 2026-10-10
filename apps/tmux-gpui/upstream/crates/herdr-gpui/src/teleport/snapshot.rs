//! Typed views of `herdr` CLI output. The GUI connection's snapshot carries no
//! split tree, launch argv, or agent session, so Teleport reads the socket API
//! snapshot through the CLI on each host. Only the fields used are decoded;
//! unknown fields are ignored so newer daemons stay readable.

use serde::Deserialize;

/// `{"id": .., "result": T}`, as every `herdr` API subcommand prints it.
#[derive(Debug, Deserialize)]
pub(crate) struct Envelope<T> {
    pub(crate) result: T,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SnapshotResult {
    pub(crate) snapshot: HostSnapshot,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct HostSnapshot {
    pub(crate) workspaces: Vec<Workspace>,
    pub(crate) tabs: Vec<Tab>,
    pub(crate) panes: Vec<Pane>,
    #[serde(default)]
    pub(crate) layouts: Vec<Layout>,
}

impl HostSnapshot {
    pub(crate) fn workspace(&self, id: &str) -> Option<&Workspace> {
        self.workspaces.iter().find(|w| w.workspace_id == id)
    }

    /// The workspace's tabs in their sidebar order.
    pub(crate) fn tabs_of(&self, workspace_id: &str) -> Vec<&Tab> {
        let mut tabs: Vec<_> = self
            .tabs
            .iter()
            .filter(|tab| tab.workspace_id == workspace_id)
            .collect();
        tabs.sort_by_key(|tab| tab.number);
        tabs
    }

    pub(crate) fn pane(&self, id: &str) -> Option<&Pane> {
        self.panes.iter().find(|pane| pane.pane_id == id)
    }

    pub(crate) fn layout(&self, tab_id: &str) -> Option<&Layout> {
        self.layouts.iter().find(|layout| layout.tab_id == tab_id)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Workspace {
    pub(crate) workspace_id: String,
    pub(crate) worktree: Option<Worktree>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct Worktree {
    pub(crate) repo_key: String,
    pub(crate) repo_name: String,
    pub(crate) repo_root: String,
    pub(crate) checkout_path: String,
    pub(crate) is_linked_worktree: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Tab {
    pub(crate) tab_id: String,
    pub(crate) workspace_id: String,
    #[serde(default)]
    pub(crate) number: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Pane {
    pub(crate) pane_id: String,
    pub(crate) tab_id: String,
    pub(crate) cwd: Option<String>,
    pub(crate) foreground_cwd: Option<String>,
    pub(crate) agent: Option<String>,
    pub(crate) agent_session: Option<AgentSession>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct AgentSession {
    pub(crate) agent: String,
    pub(crate) kind: SessionKind,
    pub(crate) source: String,
    pub(crate) value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionKind {
    Id,
    Path,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub(crate) struct Rect {
    pub(crate) x: u16,
    pub(crate) y: u16,
    pub(crate) width: u16,
    pub(crate) height: u16,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Layout {
    pub(crate) tab_id: String,
    pub(crate) panes: Vec<LayoutPane>,
    pub(crate) splits: Vec<LayoutSplit>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct LayoutPane {
    pub(crate) pane_id: String,
    pub(crate) rect: Rect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SplitDirection {
    Right,
    Down,
}

impl SplitDirection {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Right => "right",
            Self::Down => "down",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct LayoutSplit {
    /// `split_<n>_root` or `split_<n>_<path>`, where the path spells the
    /// branch from the root: `0` is the first child, `1` the second.
    pub(crate) id: String,
    pub(crate) direction: SplitDirection,
    pub(crate) ratio: f32,
    pub(crate) rect: Rect,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ProcessInfoResult {
    pub(crate) process_info: ProcessInfo,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct ProcessInfo {
    pub(crate) foreground_process_group_id: Option<u32>,
    pub(crate) shell_pid: Option<u32>,
    #[serde(default)]
    pub(crate) foreground_processes: Vec<Process>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Process {
    pub(crate) pid: u32,
    #[serde(default)]
    pub(crate) argv: Vec<String>,
    pub(crate) cwd: Option<String>,
}

impl ProcessInfo {
    /// Every process in the foreground job; none while the shell itself is in
    /// the foreground (an idle prompt).
    pub(crate) fn foreground_pids(&self) -> Vec<u32> {
        if self.foreground_process_group_id.is_none()
            || self.foreground_process_group_id == self.shell_pid
        {
            return Vec::new();
        }
        self.foreground_processes.iter().map(|p| p.pid).collect()
    }

    /// The foreground job's leader, or `None` while the shell itself is in
    /// the foreground (an idle prompt).
    pub(crate) fn foreground_job(&self) -> Option<&Process> {
        let group = self.foreground_process_group_id?;
        if Some(group) == self.shell_pid {
            return None;
        }
        self.foreground_processes
            .iter()
            .find(|process| process.pid == group)
            .or_else(|| self.foreground_processes.iter().min_by_key(|p| p.pid))
            .filter(|process| !process.argv.is_empty())
    }
}

/// `worktree_created`: the new workspace and the pane its first tab holds.
#[derive(Debug, Deserialize)]
pub(crate) struct WorktreeCreated {
    pub(crate) workspace: CreatedWorkspace,
    pub(crate) tab: CreatedTab,
    pub(crate) root_pane: CreatedPane,
    pub(crate) worktree: CreatedWorktree,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CreatedWorkspace {
    pub(crate) workspace_id: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CreatedTab {
    pub(crate) tab_id: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CreatedPane {
    pub(crate) pane_id: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CreatedWorktree {
    pub(crate) path: String,
}

/// `workspace_created`.
#[derive(Debug, Deserialize)]
pub(crate) struct WorkspaceCreated {
    pub(crate) workspace: CreatedWorkspace,
}

/// `tab_list`.
#[derive(Debug, Deserialize)]
pub(crate) struct TabList {
    pub(crate) tabs: Vec<CreatedTab>,
}

/// `tab_created`.
#[derive(Debug, Deserialize)]
pub(crate) struct TabCreated {
    pub(crate) tab: CreatedTab,
    pub(crate) root_pane: CreatedPane,
}

/// `pane_info`, as `pane split` prints the new pane.
#[derive(Debug, Deserialize)]
pub(crate) struct PaneInfoResult {
    pub(crate) pane: CreatedPane,
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn decodes_the_cli_snapshot_envelope_and_ignores_unknown_fields() {
        let json = r#"{"id":"cli:api:snapshot","result":{"type":"session_snapshot","snapshot":{
            "version":"0.9.1","protocol":22,"future":true,
            "workspaces":[{"workspace_id":"w1","label":"feat","worktree":{"checkout_path":"/w/feat",
              "is_linked_worktree":true,"repo_key":"/r/.git","repo_name":"r","repo_root":"/r"}}],
            "tabs":[{"tab_id":"w1:t2","workspace_id":"w1","number":2,"label":"b"},
                    {"tab_id":"w1:t1","workspace_id":"w1","number":1}],
            "panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","cwd":"/w/feat","agent":"claude",
              "agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"abc"}}],
            "layouts":[{"tab_id":"w1:t1","zoomed":false,"focused_pane_id":"w1:p1",
              "area":{"x":0,"y":0,"width":10,"height":5},
              "panes":[{"pane_id":"w1:p1","focused":true,"rect":{"x":0,"y":0,"width":10,"height":5}}],
              "splits":[]}],
            "agents":[]}}}"#;
        let snapshot = serde_json::from_str::<Envelope<SnapshotResult>>(json)
            .unwrap()
            .result
            .snapshot;
        let tabs: Vec<_> = snapshot
            .tabs_of("w1")
            .iter()
            .map(|t| t.tab_id.as_str())
            .collect();
        assert_eq!(tabs, ["w1:t1", "w1:t2"]);
        let pane = snapshot.pane("w1:p1").unwrap();
        assert_eq!(pane.agent_session.as_ref().unwrap().kind, SessionKind::Id);
        assert!(
            snapshot
                .workspace("w1")
                .unwrap()
                .worktree
                .as_ref()
                .unwrap()
                .is_linked_worktree
        );
        assert_eq!(snapshot.layout("w1:t1").unwrap().panes[0].pane_id, "w1:p1");
    }

    #[test]
    fn an_idle_shell_has_no_foreground_job() {
        let info: ProcessInfo = serde_json::from_str(
            r#"{"foreground_process_group_id":7,"shell_pid":7,
                "foreground_processes":[{"pid":7,"argv":["-zsh"],"cwd":"/w"}]}"#,
        )
        .unwrap();
        assert!(info.foreground_job().is_none());
        assert!(info.foreground_pids().is_empty());
        let info: ProcessInfo = serde_json::from_str(
            r#"{"foreground_process_group_id":9,"shell_pid":7,
                "foreground_processes":[{"pid":12,"argv":["node","x"]},{"pid":9,"argv":["npm","run","dev"]}]}"#,
        )
        .unwrap();
        assert_eq!(info.foreground_job().unwrap().argv, ["npm", "run", "dev"]);
        assert_eq!(info.foreground_pids(), [12, 9]);
        assert!(ProcessInfo::default().foreground_pids().is_empty());
    }
}
