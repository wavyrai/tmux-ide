//! Bounded historical previews, fenced by opaque broker route/appearance proof.
use super::{browser::State, display_frame::DisplayFrame};
use crate::terminal_painter::NativeFrame;
use herdr_client::protocol::CellData;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Weak},
};
const MAX_ENTRIES: usize = 8;
const MAX_ENTRY_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 16 * 1024 * 1024;
/// Opaque broker digests: key hashes the fleet attachment key; proof hashes the
/// current private route incarnation/epoch plus appearance theme. Neither is authority.
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Route {
    pub key: String,
    pub proof: String,
}
impl Route {
    pub fn valid(&self) -> bool {
        [&self.key, &self.proof].into_iter().all(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    }
}
struct Entry {
    proof: Route,
    frame: Arc<NativeFrame>,
    source: Weak<NativeFrame>,
    bytes: usize,
}
struct Showing {
    request: u64,
    proof: Route,
    deadline: u64,
}
#[derive(Default)]
pub(super) struct Cache {
    entries: VecDeque<Entry>,
    sizes: HashMap<usize, (Weak<[CellData]>, usize)>,
    showing: Option<Showing>,
    expired_request: Option<u64>,
}
impl Cache {
    /// Call only with the broker route proof bound to this live frame's request.
    /// Historical previews are never re-cached and history views never replace live frames.
    pub fn remember(&mut self, route: &Route, state: &State) -> bool {
        if !route.valid()
            || !state.input_ready
            || state.retained_preview
            || state.history_offset != 0
        {
            return false;
        }
        if let Some(DisplayFrame::Native(frame)) = &state.frame
            && self.entries.iter().any(|e| {
                e.proof == *route
                    && e.source
                        .upgrade()
                        .is_some_and(|old| Arc::ptr_eq(&old, frame))
            })
        {
            return true;
        }
        self.entries.retain(|e| e.proof.key != route.key);
        let Some(DisplayFrame::Native(frame)) = &state.frame else {
            return false;
        };
        self.sizes.retain(|_, (row, _)| row.strong_count() > 0);
        let mut bytes = size_of::<NativeFrame>() + frame.rows.len() * size_of::<Arc<[CellData]>>();
        for row in &frame.rows {
            let key = Arc::as_ptr(row) as *const CellData as usize;
            let size = self
                .sizes
                .get(&key)
                .filter(|(old, _)| old.upgrade().is_some_and(|old| Arc::ptr_eq(&old, row)))
                .map(|(_, size)| *size)
                .unwrap_or_else(|| {
                    let size = size_of_val(row.as_ref()).saturating_add(
                        row.iter().map(|cell| cell.symbol.capacity()).sum::<usize>(),
                    );
                    self.sizes.insert(key, (Arc::downgrade(row), size));
                    size
                });
            bytes = bytes.saturating_add(size);
            if bytes > MAX_ENTRY_BYTES {
                return false;
            }
        }
        while self.entries.len() >= MAX_ENTRIES
            || self
                .entries
                .iter()
                .map(|e| e.bytes)
                .sum::<usize>()
                .saturating_add(bytes)
                > MAX_TOTAL_BYTES
        {
            self.entries.pop_front();
        }
        // Only row handles are copied. Hide the stale cursor even before any repaint.
        let preview = Arc::new(NativeFrame {
            rows: frame.rows.clone(),
            width: frame.width,
            height: frame.height,
            cursor: None,
        });
        self.entries.push_back(Entry {
            proof: route.clone(),
            frame: preview,
            source: Arc::downgrade(frame),
            bytes,
        });
        true
    }
    /// Show a wholly historical frame on an explicit broker preview intent. No
    /// current pane/layout facts are combined with its cells. The broker must match
    /// request and presence revision and revalidate the route proof on every update.
    pub fn show(&mut self, route: &Route, state: &mut State, foreground: bool, now: u64) -> bool {
        if !route.valid()
            || !foreground
            || state.input_ready
            || (state.frame.is_some() && !state.retained_preview)
        {
            self.clear_preview(state);
            return false;
        }
        self.entries
            .retain(|e| e.proof.key != route.key || e.proof == *route);
        if self.expired_request == Some(state.request) {
            self.clear_preview(state);
            return false;
        }
        let same = self
            .showing
            .as_ref()
            .is_some_and(|s| s.request == state.request && s.proof == *route);
        if !same {
            self.clear_preview(state);
            self.showing = Some(Showing {
                request: state.request,
                proof: route.clone(),
                deadline: now.saturating_add(5000),
            });
        }
        if self.showing.as_ref().is_some_and(|s| now >= s.deadline) {
            self.expired_request = Some(state.request);
            self.clear_preview(state);
            return false;
        }
        let Some(entry) = self.entries.iter().find(|e| e.proof == *route) else {
            self.clear_preview(state);
            return false;
        };
        state.frame = Some(DisplayFrame::Native(entry.frame.clone()));
        state.retained_preview = true;
        state.selected_pane = None;
        state.input_ready = false;
        state.input_targets.clear();
        state.input_target_rejected = true;
        state.selection_identity = None;
        state.copy_region = None;
        state.pointer_modes = None;
        state.regions.clear();
        state.graphics.clear();
        state.pane_actions = None;
        state.resize_token = None;
        state.resize_gesture_supported = false;
        state.resize_gesture = None;
        state.split_layout = None;
        state.split_gesture = None;
        state.diagnostics = None;
        state.history_offset = 0;
        state.status = "Reconnecting terminal — showing previous frame".into();
        true
    }
    pub fn clear_preview(&mut self, state: &mut State) {
        if let Some(showing) = self.showing.take() {
            self.expired_request = Some(showing.request);
        }
        if state.retained_preview {
            state.frame = None;
            state.retained_preview = false;
        }
    }
    /// Router calls on route invalidation or loss of the broker route proof.
    pub fn clear(&mut self, state: &mut State) {
        self.clear_preview(state);
        self.entries.clear();
        self.sizes.clear();
        self.expired_request = None;
    }
}
#[cfg(test)]
#[path = "browser_native_preview_tests.rs"]
mod tests;
