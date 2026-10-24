use super::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowLink {
    pub live_session_id: String,
    pub link_id: String,
    pub expected_semantic_window_id: String,
    pub link_revision: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "by", rename_all = "lowercase", deny_unknown_fields)]
pub enum WindowTarget {
    Pane {
        #[serde(rename = "semanticPaneId")]
        semantic_pane_id: String,
    },
    Window {
        #[serde(rename = "semanticWindowId")]
        semantic_window_id: String,
    },
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    Cols,
    Rows,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Right,
    Down,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Zoom {
    Toggle,
    Zoomed,
    Unzoomed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "lowercase", deny_unknown_fields)]
pub enum Rename {
    Session {
        name: String,
    },
    Window {
        target: WindowTarget,
        name: String,
    },
    Pane {
        #[serde(rename = "semanticPaneId")]
        pane: String,
        name: String,
    },
}
/// GUI operations currently supported by the native command path. Workspace is
/// stamped by Policy; no caller can change the redeemed socket's scope.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "verb", deny_unknown_fields)]
pub enum Intent {
    #[serde(rename = "workspace.rename")]
    Rename(Rename),
    #[serde(rename = "workspace.pane.zoom.toggle")]
    Zoom {
        #[serde(rename = "semanticPaneId")]
        pane: String,
        desired: Zoom,
    },
    #[serde(rename = "workspace.pane.swap")]
    Swap {
        #[serde(rename = "sourceSemanticPaneId")]
        source: String,
        #[serde(rename = "targetSemanticPaneId")]
        target: String,
    },
    #[serde(rename = "workspace.window.split.resize")]
    ResizeSplit { target: SplitTarget },
    #[serde(rename = "workspace.pane.select")]
    Select {
        #[serde(rename = "semanticPaneId")]
        pane: String,
        #[serde(rename = "windowLink", skip_serializing_if = "Option::is_none")]
        window_link: Option<WindowLink>,
    },
    #[serde(rename = "workspace.pane.resize")]
    Resize {
        #[serde(rename = "semanticPaneId")]
        pane: String,
        axis: Axis,
        cells: u16,
    },
    #[serde(rename = "workspace.window.split")]
    Split {
        #[serde(rename = "semanticPaneId")]
        pane: String,
        direction: Direction,
        #[serde(rename = "displayTitle", skip_serializing_if = "Option::is_none")]
        display_title: Option<String>,
    },
    #[serde(rename = "workspace.pane.kill")]
    KillPane {
        #[serde(rename = "semanticPaneId")]
        pane: String,
    },
    #[serde(rename = "workspace.window.kill")]
    KillWindow { target: WindowTarget },
    #[serde(rename = "workspace.session.kill")]
    KillSession,
    #[serde(rename = "workspace.window.link.select")]
    SelectLink { target: WindowLink },
    #[serde(rename = "workspace.window.link.unlink")]
    Unlink { target: WindowLink },
}
pub(super) struct PendingIntent {
    intent: Intent,
    deadline: u64,
    lifetimes: BTreeMap<String, Lifetime>,
    input: Lease,
    geometry: Option<Lease>,
    topology: Option<(String, WindowLink, Axis)>,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase", deny_unknown_fields)]
pub enum IntentOutcome {
    Applied { result: Option<Value> },
    Rejected { code: String, message: String },
}
#[derive(Debug)]
pub struct IntentCompletion {
    pub operation_id: String,
    pub outcome: IntentOutcome,
    pub current: bool,
}
impl Policy {
    /// Reserves one bounded operation correlation. Semantic commands are barriers;
    /// no command is retried after timeout, socket loss, or an uncertain result.
    pub fn submit_intent(
        &mut self,
        operation_id: &str,
        intent: Intent,
        now: u64,
    ) -> Result<Command> {
        self.check()?;
        if !self.owns(Authority::Input) {
            return Err(Error::Authority);
        }
        if !self.barrier_ready() {
            return Err(Error::Busy);
        }
        if !uuid(operation_id) || self.intents.contains_key(operation_id) {
            return Err(Error::Invalid);
        }
        if self.intents.len() >= 16 {
            return Err(Error::Full);
        }
        intent.validate()?;
        if intent.geometry() && !self.owns(Authority::Geometry) {
            return Err(Error::Authority);
        }
        let input = self
            .grants
            .get(&Authority::Input)
            .ok_or(Error::Authority)?
            .clone();
        let geometry = if intent.geometry() {
            self.grants.get(&Authority::Geometry).cloned()
        } else {
            None
        };
        let mut lifetimes = BTreeMap::new();
        if let Some(pane) = intent.target_pane() {
            lifetimes.insert(
                pane.into(),
                self.lifetimes.get(pane).ok_or(Error::Lifetime)?.clone(),
            );
        }
        if let Intent::Swap { target, .. } = &intent {
            lifetimes.insert(
                target.clone(),
                self.lifetimes.get(target).ok_or(Error::Lifetime)?.clone(),
            );
        }
        let topology = if let Intent::ResizeSplit { target } = &intent {
            let (lifetime, resource) = self.split_layout.as_ref().ok_or(Error::Lifetime)?;
            if resource.window != target.window || resource.layout_id != target.layout_id {
                return Err(Error::Lifetime);
            }
            let split = resource
                .splits
                .iter()
                .find(|s| s.split_id == target.split_id)
                .ok_or(Error::Lifetime)?;
            Some((lifetime.clone(), resource.window.clone(), split.axis))
        } else {
            None
        };
        let mut value = serde_json::to_value(&intent)?;
        value["workspaceName"] = json!(self.workspace);
        let command =
            command(json!({"type":"semantic-intent","operationId":operation_id,"intent":value}))?;
        self.intents.insert(
            operation_id.into(),
            PendingIntent {
                intent,
                deadline: now.saturating_add(12000),
                lifetimes,
                input,
                geometry,
                topology,
            },
        );
        Ok(command)
    }
    pub(super) fn accept_intent(
        &mut self,
        operation_id: String,
        outcome: IntentOutcome,
    ) -> Result<Outcome> {
        let pending = self.intents.get(&operation_id).ok_or(Error::Invalid)?;
        match &outcome {
            IntentOutcome::Applied {
                result: Some(result),
            } => pending.intent.validate_result(
                result,
                &operation_id,
                &self.workspace,
                &self.generation,
                pending.topology.as_ref().map(|(_, _, axis)| *axis),
            )?,
            IntentOutcome::Applied { result: None } => return Err(Error::Invalid),
            IntentOutcome::Rejected { code, message } => {
                if message.is_empty()
                    || message.encode_utf16().count() > 512
                    || !matches!(
                        code.as_str(),
                        "controller-conflict"
                            | "controller-target-unavailable"
                            | "stale-controller-lease"
                            | "invalid-client-capability"
                            | "invalid-source-pane-binding"
                            | "intent-session-mismatch"
                            | "intent-rejected"
                            | "intent-timed-out"
                            | "pane_inventory_not_ready"
                            | "pane_identity_changed_before_select"
                            | "pane_not_active"
                            | "stream-unavailable"
                    )
                {
                    return Err(Error::Invalid);
                }
            }
        }
        let topology_current =
            pending
                .topology
                .as_ref()
                .is_none_or(|(expected_lifetime, expected_window, _)| {
                    self.split_scope.as_ref().is_some_and(|(lifetime, window)| {
                        lifetime == expected_lifetime && window == expected_window
                    })
                });
        let current = topology_current
            && self.owns(Authority::Input)
            && self.grants.get(&Authority::Input) == Some(&pending.input)
            && pending
                .geometry
                .as_ref()
                .is_none_or(|lease| self.grants.get(&Authority::Geometry) == Some(lease))
            && pending
                .lifetimes
                .iter()
                .all(|(pane, lifetime)| self.lifetimes.get(pane) == Some(lifetime));
        self.intents.remove(&operation_id);
        Ok(Outcome {
            intent: Some(IntentCompletion {
                operation_id,
                outcome,
                current,
            }),
            ..Outcome::default()
        })
    }
    pub(super) fn expire_intents(&mut self, now: u64) -> Vec<String> {
        let ids: Vec<_> = self
            .intents
            .iter()
            .filter(|(_, p)| p.deadline <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            self.intents.remove(id);
        }
        ids
    }
}
impl Intent {
    fn geometry(&self) -> bool {
        !matches!(
            self,
            Self::Select { .. } | Self::SelectLink { .. } | Self::Rename(_)
        )
    }
    fn target_pane(&self) -> Option<&str> {
        match self {
            Self::Rename(Rename::Pane { pane, .. })
            | Self::Zoom { pane, .. }
            | Self::Swap { source: pane, .. }
            | Self::Select { pane, .. }
            | Self::Resize { pane, .. }
            | Self::Split { pane, .. }
            | Self::KillPane { pane } => Some(pane),
            Self::KillWindow {
                target: WindowTarget::Pane { semantic_pane_id },
            } => Some(semantic_pane_id),
            _ => None,
        }
    }
    fn validate(&self) -> Result<()> {
        let valid = match self {
            Self::Rename(target) => match target {
                Rename::Session { name } => title(name),
                Rename::Pane { pane: id, name } => pane(id) && title(name),
                Rename::Window { target, name } => valid_window(target) && title(name),
            },
            Self::Zoom { pane: id, .. } => pane(id),
            Self::Swap { source, target } => pane(source) && pane(target),
            Self::ResizeSplit { target } => target.validate().is_ok(),
            Self::Select {
                pane: id,
                window_link,
            } => pane(id) && window_link.as_ref().is_none_or(valid_link),
            Self::Resize {
                pane: id, cells, ..
            } => pane(id) && (1..=4096).contains(cells),
            Self::Split {
                pane: id,
                display_title,
                ..
            } => pane(id) && display_title.as_deref().is_none_or(title),
            Self::KillPane { pane: id } => pane(id),
            Self::KillWindow { target } => match target {
                WindowTarget::Pane { semantic_pane_id } => pane(semantic_pane_id),
                WindowTarget::Window { semantic_window_id } => pane(semantic_window_id),
            },
            Self::KillSession => true,
            Self::SelectLink { target } | Self::Unlink { target } => valid_link(target),
        };
        if valid { Ok(()) } else { Err(Error::Invalid) }
    }
    fn validate_result(
        &self,
        v: &Value,
        operation: &str,
        workspace: &str,
        generation: &str,
        expected_axis: Option<Axis>,
    ) -> Result<()> {
        let object = v.as_object().ok_or(Error::Invalid)?;
        let request = serde_json::to_value(self)?;
        if v["operationId"] != operation
            || v["workspaceName"] != workspace
            || v["verb"] != request["verb"]
            || v["daemonInstanceId"] != generation
            || !v["outcome"]
                .as_str()
                .is_some_and(|s| matches!(s, "applied" | "unchanged" | "replayed"))
        {
            return Err(Error::Invalid);
        }
        let (extras, valid): (&[&str], bool) = match self {
            Self::Rename(target) => {
                let request = serde_json::to_value(target)?;
                (
                    &["scope", "name"],
                    v["scope"] == request["scope"]
                        && v["name"] == request["name"]
                        && matches!(v["outcome"].as_str(), Some("applied" | "unchanged")),
                )
            }
            Self::Zoom { pane, desired } => (
                &["semanticPaneId", "zoomed"],
                v["semanticPaneId"] == *pane
                    && v["zoomed"].as_bool().is_some_and(|zoomed| match desired {
                        Zoom::Toggle => true,
                        Zoom::Zoomed => zoomed,
                        Zoom::Unzoomed => !zoomed,
                    })
                    && matches!(v["outcome"].as_str(), Some("applied" | "unchanged")),
            ),
            Self::Swap { source, target } => (
                &["sourceSemanticPaneId", "targetSemanticPaneId"],
                v["sourceSemanticPaneId"] == *source && v["targetSemanticPaneId"] == *target,
            ),
            Self::ResizeSplit { target } => {
                let boundary = v["boundary"]
                    .as_u64()
                    .filter(|n| *n <= 4096)
                    .ok_or(Error::Invalid)?;
                let axis = expected_axis.ok_or(Error::Invalid)?;
                if let Some(successor) = v.get("successor").filter(|v| !v.is_null()) {
                    let successor: SplitSuccessor = serde_json::from_value(successor.clone())?;
                    successor.validate()?;
                    let split = successor
                        .resource
                        .splits
                        .iter()
                        .find(|s| s.split_id == successor.split_id)
                        .ok_or(Error::Invalid)?;
                    if successor.resource.window != target.window
                        || split.axis != axis
                        || u64::from(split.boundary) != boundary
                    {
                        return Err(Error::Invalid);
                    }
                }
                (
                    if v.get("successor").is_some() {
                        &["target", "axis", "boundary", "successor"]
                    } else {
                        &["target", "axis", "boundary"]
                    },
                    v["target"] == serde_json::to_value(target)?
                        && v["axis"] == serde_json::to_value(axis)?,
                )
            }
            Self::Select { pane, .. } => (&["semanticPaneId"], v["semanticPaneId"] == *pane),
            Self::Resize { pane, axis, .. } => (
                &["semanticPaneId", "axis", "cells"],
                v["semanticPaneId"] == *pane
                    && v["axis"] == serde_json::to_value(axis)?
                    && positive(&v["cells"]),
            ),
            Self::Split {
                direction,
                pane: source,
                ..
            } => (
                &["semanticPaneId", "direction", "displayTitle"],
                v["outcome"] == "applied"
                    && v["semanticPaneId"] != *source
                    && v["semanticPaneId"].as_str().is_some_and(pane)
                    && v["direction"] == serde_json::to_value(direction)?
                    && v["displayTitle"].as_str().is_some_and(title),
            ),
            Self::KillPane { .. } => (
                &["windowClosed", "remainingWindowCount"],
                v["windowClosed"].is_boolean() && positive(&v["remainingWindowCount"]),
            ),
            Self::KillWindow { .. } => (
                &["remainingWindowCount"],
                positive(&v["remainingWindowCount"]),
            ),
            Self::KillSession => (&[], true),
            Self::SelectLink { target } | Self::Unlink { target } => {
                (&["target"], v["target"] == serde_json::to_value(target)?)
            }
        };
        let common = [
            "operationId",
            "daemonInstanceId",
            "workspaceName",
            "outcome",
            "verb",
        ];
        if !valid
            || object.len() != common.len() + extras.len()
            || object
                .keys()
                .any(|k| !common.contains(&k.as_str()) && !extras.contains(&k.as_str()))
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}
fn title(s: &str) -> bool {
    !s.is_empty()
        && s.encode_utf16().count() <= 80
        && s.trim() == s
        && !s.chars().any(|c| c.is_control())
}
fn positive(v: &Value) -> bool {
    v.as_u64().is_some_and(|n| n > 0 && n <= SAFE)
}
pub(super) fn valid_link(l: &WindowLink) -> bool {
    fn hex(s: &str, prefix: &str, length: usize) -> bool {
        s.strip_prefix(prefix).is_some_and(|s| {
            s.len() == length
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    }
    hex(&l.live_session_id, "live-session.", 20)
        && hex(&l.link_id, "window-link.", 32)
        && pane(&l.expected_semantic_window_id)
        && l.link_revision <= SAFE
}

fn valid_window(target: &WindowTarget) -> bool {
    match target {
        WindowTarget::Pane { semantic_pane_id } => pane(semantic_pane_id),
        WindowTarget::Window { semantic_window_id } => pane(semantic_window_id),
    }
}
