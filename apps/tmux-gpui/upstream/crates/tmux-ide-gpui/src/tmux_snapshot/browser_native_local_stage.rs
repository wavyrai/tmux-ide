//! The catalog worker stage the local owner is waiting on, and the catalog
//! action each stage sends.
use super::*;

pub(super) enum Stage {
    AgentOpen {
        target: Target,
        selection: Box<herdr_client::tmux_daemon::AgentSelection>,
    },
    LocalProve,
    LocalCreate {
        proof: herdr_client::tmux_daemon::LocalSessionProof,
        operation_id: uuid::Uuid,
        name: String,
    },
    LocalCatalog {
        proof: herdr_client::tmux_daemon::LocalSessionProof,
        receipt: herdr_client::tmux_daemon::CreatedSession,
    },
    Preferences {
        change: Option<(
            herdr_client::tmux_daemon::LocalOwnerStamp,
            herdr_client::tmux_daemon::FleetPreferenceChange,
        )>,
    },
    AddMachine {
        target: String,
    },
    VerifyProfile,
    MachineSelection {
        expected: herdr_client::tmux_daemon::SavedMachineRegistry,
        id: String,
    },
    Machines {
        change: Option<(
            herdr_client::tmux_daemon::SavedMachineRegistry,
            herdr_client::tmux_daemon::MachineChange,
        )>,
    },
    Owner {
        scope: ServerScope,
        operation_id: uuid::Uuid,
        creation: herdr_client::tmux_daemon::PaneCreation,
        request: browser_native_owner::Request,
    },
    Editor {
        scope: ServerScope,
        target: herdr_client::tmux_daemon::EditorTarget,
        request: super::super::super::super::browser_native_editor::Request,
    },
    History {
        scope: ServerScope,
        id: String,
        request: u64,
        operation_id: u64,
        body: herdr_client::tmux_history::AnchorRequest,
    },
    Create {
        scope: ServerScope,
        operation_id: uuid::Uuid,
        name: String,
    },
    Servers,
    Open {
        target: Target,
        preferred: Option<String>,
    },
    Issue {
        target: Target,
        workspace: String,
        panes: Vec<String>,
        selected: String,
    },
}
impl Stage {
    pub(super) fn local_owner(&self) -> bool {
        self.registry()
            || matches!(
                self,
                Self::Preferences { .. }
                    | Self::LocalProve
                    | Self::LocalCreate { .. }
                    | Self::LocalCatalog { .. }
            )
    }
    pub(super) fn registry(&self) -> bool {
        matches!(
            self,
            Self::Machines { .. }
                | Self::MachineSelection { .. }
                | Self::VerifyProfile
                | Self::AddMachine { .. }
        )
    }
    pub(super) fn action(&self) -> CatalogAction {
        match self {
            Self::AgentOpen { target, selection } => CatalogAction::OpenObservedAgent {
                scope: target.scope.clone(),
                selection: selection.clone(),
            },
            Self::LocalProve => CatalogAction::ProveLocalSession,
            Self::LocalCreate {
                proof,
                operation_id,
                name,
            } => CatalogAction::CreateLocalSession {
                proof: proof.clone(),
                operation_id: *operation_id,
                display_name: name.clone(),
            },
            Self::LocalCatalog { proof, .. } => CatalogAction::LocalSessionCatalog {
                proof: proof.clone(),
            },
            Self::Preferences { change } => CatalogAction::FleetPreferences {
                change: change.clone(),
            },
            Self::AddMachine { target } => CatalogAction::PrepareMachine {
                target: target.clone(),
            },
            Self::MachineSelection { .. } | Self::VerifyProfile => CatalogAction::SavedMachines,
            Self::Machines { change: None } => CatalogAction::SavedMachines,
            Self::Machines {
                change: Some((expected, change)),
            } => CatalogAction::MutateMachine {
                expected: expected.clone(),
                change: change.clone(),
            },
            Self::Owner {
                scope,
                operation_id,
                creation,
                ..
            } => CatalogAction::CreatePane {
                scope: scope.clone(),
                operation_id: *operation_id,
                creation: creation.clone(),
            },
            Self::Editor { scope, target, .. } => CatalogAction::OpenEditor {
                scope: scope.clone(),
                target: target.clone(),
            },
            Self::Servers => CatalogAction::FleetCatalog,
            Self::Create {
                scope,
                operation_id,
                name,
            } => CatalogAction::Create {
                scope: scope.clone(),
                operation_id: *operation_id,
                display_name: name.clone(),
            },
            Self::History { scope, body, .. } => CatalogAction::History {
                scope: scope.clone(),
                request: body.clone(),
            },
            Self::Open { target, .. } => CatalogAction::Open {
                scope: target.scope.clone(),
                live_session_id: target.live.clone(),
            },
            Self::Issue {
                target,
                workspace,
                panes,
                selected,
            } => CatalogAction::Issue {
                scope: target.scope.clone(),
                selection: TerminalSelection {
                    workspace_name: workspace.clone(),
                    live_session_id: target.live.clone(),
                    selected_pane: selected.clone(),
                    visible_panes: panes.clone(),
                    mode: ViewerMode::Interactive,
                },
            },
        }
    }
}
