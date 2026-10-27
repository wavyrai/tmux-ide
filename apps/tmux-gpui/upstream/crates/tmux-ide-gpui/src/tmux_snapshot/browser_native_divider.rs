//! Exact canonical ancestry adapter; metadata conversion never touches terminal cells.
use super::{
    browser,
    divider::{self, canonical, gesture},
};
use herdr_client::{
    tmux_control::{Axis, SplitLayout, SplitTarget, WindowLink},
    tmux_controller::{Controller, DividerState, SplitPhase, SplitRead, Update},
};
/// Bounded broker metadata; no terminal cells or authority can arrive here.
pub(super) struct SplitResponse {
    pub id: String,
    pub request: u64,
    pub sequence: u64,
    pub resource: Option<SplitLayout>,
}
#[derive(serde::Deserialize)]
#[serde(tag = "status", rename_all = "lowercase", deny_unknown_fields)]
enum WireResponse {
    Ok {
        #[serde(rename = "type")]
        kind: String,
        version: u8,
        id: String,
        request: u64,
        sequence: u64,
        resource: SplitLayout,
    },
    Failed {
        #[serde(rename = "type")]
        kind: String,
        version: u8,
        id: String,
        request: u64,
        sequence: u64,
    },
}
impl SplitResponse {
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        if bytes.len() > 256 * 1024 + 1024 {
            return None;
        }
        let wire: WireResponse = serde_json::from_slice(bytes).ok()?;
        let (kind, version, id, request, sequence, resource) = match wire {
            WireResponse::Ok {
                kind,
                version,
                id,
                request,
                sequence,
                resource,
            } => {
                resource.validate().ok()?;
                (kind, version, id, request, sequence, Some(resource))
            }
            WireResponse::Failed {
                kind,
                version,
                id,
                request,
                sequence,
            } => (kind, version, id, request, sequence, None),
        };
        if kind != "native-split-layout-result"
            || version != 1
            || uuid::Uuid::parse_str(&id).is_err()
            || request > 9_007_199_254_740_991
            || sequence == 0
            || sequence > 9_007_199_254_740_991
        {
            return None;
        }
        Some(Self {
            id,
            request,
            sequence,
            resource,
        })
    }
}
#[derive(Default)]
pub(super) struct DividerOwner {
    state: DividerState,
}
impl DividerOwner {
    pub fn busy(&self) -> bool {
        self.state.busy()
    }
    pub fn poll(
        &mut self,
        c: &mut Controller,
        update: &Update,
        now: u64,
    ) -> Result<(), herdr_client::tmux_controller::Error> {
        self.state.observe(c, update, now)
    }
    pub fn take_read(&mut self) -> Option<SplitRead> {
        self.state.take_read()
    }
    pub fn rebind_request(&mut self) -> Result<(), herdr_client::tmux_controller::Error> {
        self.state.rebind_request()
    }
    pub fn read_failed(&mut self, sequence: u64) {
        self.state.read_failed(sequence);
    }
    pub fn accept_resource(
        &mut self,
        c: &mut Controller,
        sequence: u64,
        resource: SplitLayout,
    ) -> Result<bool, herdr_client::tmux_controller::Error> {
        self.state.accept_resource(c, sequence, resource)
    }
    pub fn continuation(&self, gesture: &str, update: &canonical::Update) -> bool {
        self.state.matches_gesture(gesture)
            && matches!(
                update,
                canonical::Update::Release { .. } | canonical::Update::Cancel
            )
    }
    pub fn command(
        &mut self,
        c: &mut Controller,
        gesture: &str,
        update: canonical::Update,
        now: u64,
    ) -> Result<bool, herdr_client::tmux_controller::Error> {
        let boundary = match &update {
            canonical::Update::Begin { target, .. } => target.boundary,
            canonical::Update::Release { boundary } => *boundary,
            canonical::Update::Cancel => 0,
        };
        let result = match update {
            canonical::Update::Begin { target, axis } => self.state.begin(
                c,
                gesture,
                SplitTarget {
                    window: window_from(target.window),
                    layout_id: target.layout_id,
                    split_id: target.split_id,
                    boundary: target.boundary,
                },
                match axis {
                    divider::Axis::Cols => Axis::Cols,
                    divider::Axis::Rows => Axis::Rows,
                },
                now,
            ),
            canonical::Update::Release { boundary } => {
                self.state.release(c, gesture, boundary, now)
            }
            canonical::Update::Cancel => {
                if self
                    .state
                    .publication()
                    .is_some_and(|p| p.gesture == gesture)
                {
                    self.state.cancel();
                }
                Ok(())
            }
        };
        match result {
            Ok(()) => Ok(true),
            Err(herdr_client::tmux_controller::Error::Invalid)
            | Err(herdr_client::tmux_controller::Error::Control(
                herdr_client::tmux_control::Error::Busy,
            )) => {
                self.state.reject(gesture, boundary);
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }
    pub fn focus_loss(&mut self) {
        self.state.cancel();
    }
    pub fn publish(&self, state: &mut browser::State) {
        state.split_layout = self.state.resource().map(layout);
        state.split_gesture = self.state.publication().map(|p| canonical::Ack {
            gesture: p.gesture.clone(),
            phase: match p.phase {
                SplitPhase::Dragging => gesture::Phase::Dragging,
                SplitPhase::Pending => gesture::Phase::Pending,
                SplitPhase::Settled => gesture::Phase::Settled,
                SplitPhase::Failed => gesture::Phase::Failed,
                SplitPhase::Cancelled => gesture::Phase::Cancelled,
            },
            revision: p.revision,
            boundary: p.boundary,
            target: p.target.as_ref().map(|t| canonical::Target {
                window: window(&t.window),
                layout_id: t.layout_id.clone(),
                split_id: t.split_id.clone(),
                boundary: t.boundary,
            }),
        });
    }
}
fn window_from(w: canonical::Window) -> WindowLink {
    WindowLink {
        live_session_id: w.live_session_id,
        link_id: w.link_id,
        expected_semantic_window_id: w.expected_semantic_window_id,
        link_revision: w.link_revision,
    }
}
fn window(w: &WindowLink) -> canonical::Window {
    canonical::Window {
        live_session_id: w.live_session_id.clone(),
        link_id: w.link_id.clone(),
        expected_semantic_window_id: w.expected_semantic_window_id.clone(),
        link_revision: w.link_revision,
    }
}
fn layout(value: &SplitLayout) -> canonical::Layout {
    canonical::Layout {
        version: value.version,
        window: window(&value.window),
        layout_id: value.layout_id.clone(),
        cols: value.cols,
        rows: value.rows,
        panes: value
            .panes
            .iter()
            .map(|p| canonical::Pane {
                semantic_pane_id: p.semantic_pane_id.clone(),
                left: p.left,
                top: p.top,
                width: p.width,
                height: p.height,
            })
            .collect(),
        splits: value
            .splits
            .iter()
            .map(|s| canonical::Edge {
                split_id: s.split_id.clone(),
                axis: match s.axis {
                    Axis::Cols => divider::Axis::Cols,
                    Axis::Rows => divider::Axis::Rows,
                },
                boundary: s.boundary,
                start: s.start,
                length: s.length,
            })
            .collect(),
    }
}
#[cfg(test)]
#[path = "browser_native_divider_tests.rs"]
mod tests;
