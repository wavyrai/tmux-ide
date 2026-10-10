//! Display labels never become routing identities.
use super::browser::State;
pub(super) fn selected_title(state: &State) -> Option<String> {
    let selected = state.selected_pane.as_deref()?;
    let pane = state.panes.iter().find(|pane| pane.id == selected)?;
    let label: String = pane
        .label
        .chars()
        .filter(|c| !c.is_control())
        .take(96)
        .collect();
    Some(format!(
        "Selected: {}",
        if label.trim().is_empty() {
            "Pane"
        } else {
            &label
        }
    ))
}
#[cfg(test)]
#[path = "pane_chrome_tests.rs"]
mod tests;

use super::{SnapshotView, browser_ui::Selection, hit_regions};
use gpui::{prelude::*, *};
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Header {
    id: String,
    left: u16,
    width: u16,
    // None denotes the app-owned row above the framebuffer.
    row: Option<u16>,
}
fn headers(state: &State) -> Vec<Header> {
    let Some(frame) = state.frame.as_ref() else {
        return Vec::new();
    };
    if state.surface != super::browser::Surface::Workspace
        || frame.width > 1000
        || frame.height > 500
        || !frame.graphics.is_empty()
        || !hit_regions::valid(&state.regions, Some(frame), &state.panes)
    {
        return Vec::new();
    }
    state
        .regions
        .iter()
        .filter_map(|pane| {
            if pane.top == 0 {
                return Some(Header {
                    id: pane.id.clone(),
                    left: pane.left,
                    width: pane.width,
                    row: None,
                });
            }
            // Existing separator projection protects ALL outer rectangles, including
            // status rows, and rejects visible/attributed data in nominal gaps.
            let cells = hit_regions::separator_cells(&pane.id, &state.regions, frame, &state.panes);
            let mut best = (0, 0);
            let mut run = (0, 0);
            for col in pane.left..pane.left + pane.width {
                if cells
                    .iter()
                    .any(|c| !c.vertical && c.row == pane.top - 1 && c.col == col)
                {
                    if run.1 == 0 {
                        run.0 = col;
                    }
                    run.1 += 1;
                    if run.1 > best.1 {
                        best = run;
                    }
                } else {
                    run.1 = 0;
                }
            }
            (best.1 > 0).then(|| Header {
                id: pane.id.clone(),
                left: best.0,
                width: best.1,
                row: Some(pane.top - 1),
            })
        })
        .collect()
}
fn label(state: &State, id: &str) -> String {
    state
        .panes
        .iter()
        .find(|p| p.id == id)
        .map(|p| {
            let label: String = p
                .label
                .chars()
                .filter(|c| !c.is_control())
                .take(96)
                .collect();
            if label.trim().is_empty() {
                "Pane".into()
            } else {
                label
            }
        })
        .unwrap_or_else(|| "Pane".into())
}
fn current_header(
    view: &SnapshotView,
    request: u64,
    frame: &Arc<herdr_client::protocol::FrameData>,
    regions: &[hit_regions::Region],
    id: &str,
) -> bool {
    view.browser_request == request
        && view.browser_state.request == request
        && view.presence.ready()
        && view.browser_commands.is_some()
        && view.picker.is_none()
        && view.pane_actions.is_none()
        && view.new_session.is_none()
        && view.selection.is_none()
        && view.divider.is_none()
        && hit_regions::is_painted(Some(frame), view.frame.as_ref())
        && hit_regions::is_painted(Some(frame), view.painted_frame.as_ref())
        && publication_current(&view.browser_state, request, frame, regions, id)
}
fn publication_current(
    state: &State,
    request: u64,
    frame: &Arc<herdr_client::protocol::FrameData>,
    regions: &[hit_regions::Region],
    id: &str,
) -> bool {
    state.request == request
        && hit_regions::is_painted(Some(frame), state.frame.as_ref())
        && state.regions == regions
        && headers(state).iter().any(|h| h.id == id && h.row.is_none())
}
impl SnapshotView {
    pub(super) fn pane_header_row(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let width = self
            .painter
            .borrow_mut()
            .cell_width(&font("Menlo"), window, cx);
        let theme = self.theme();
        let mut row = div()
            .id("pane-header-row")
            .debug_selector(|| "pane-header-row".into())
            .relative()
            .w_full()
            .h(px(crate::terminal::CELL_HEIGHT))
            .flex_shrink_0()
            .overflow_hidden()
            .bg(rgb(theme.surface));
        if !hit_regions::is_painted(self.frame.as_ref(), self.browser_state.frame.as_ref())
            || self.selection.is_some()
        {
            return row.into_any_element();
        }
        for header in headers(&self.browser_state)
            .into_iter()
            .filter(|h| h.row.is_none())
        {
            let request = self.browser_request;
            let Some(frame) = self.browser_state.frame.clone() else {
                continue;
            };
            let regions = self.browser_state.regions.clone();
            let id = header.id.clone();
            row = row.child(
                self.pane_header_label(&header, width)
                    .id(SharedString::from(format!("pane-header:{}", header.id)))
                    .cursor_pointer()
                    .on_click(cx.listener(move |view, _, window, cx| {
                        if current_header(view, request, &frame, &regions, &id) {
                            if view.browser_state.selected_pane.as_ref() != Some(&id) {
                                view.select(Selection::Pane(id.clone()), window, cx);
                            } else {
                                // Focus alone never restores interrupted input authority.
                                view.terminal_focus.focus(window, cx);
                            }
                        }
                    })),
            );
        }
        row.into_any_element()
    }
    fn pane_header_label(&self, header: &Header, width: f32) -> Div {
        let selected = self.browser_state.selected_pane.as_deref() == Some(&header.id);
        let theme = self.theme();
        // Herdr sidebar/row.rs label budgeting and selection styling, rendered
        // with native elements. Never insert title glyphs into terminal cells.
        div()
            .absolute()
            .left(px(f32::from(header.left) * width))
            .top(px(header
                .row
                .map_or(0., |r| f32::from(r) * crate::terminal::CELL_HEIGHT)))
            .w(px(f32::from(header.width) * width))
            .h(px(crate::terminal::CELL_HEIGHT))
            .min_w_0()
            .overflow_hidden()
            .px(px(width.min(4.)))
            .bg(rgb(if selected {
                theme.active
            } else {
                theme.surface
            }))
            .text_color(rgb(if selected {
                theme.foreground
            } else {
                theme.muted
            }))
            .text_size(px((crate::terminal::CELL_HEIGHT - 2.).min(12.)))
            .font_weight(if selected {
                FontWeight::SEMIBOLD
            } else {
                FontWeight::NORMAL
            })
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .child(label(&self.browser_state, &header.id)),
            )
    }
    pub(super) fn lower_pane_headers(&self, width: f32) -> Vec<Div> {
        if self.selection.is_some()
            || !hit_regions::is_painted(self.frame.as_ref(), self.browser_state.frame.as_ref())
        {
            return Vec::new();
        }
        // No event handlers/hitboxes: existing divider handles retain priority,
        // including the whole horizontal separator beneath these labels.
        headers(&self.browser_state)
            .iter()
            .filter(|h| h.row.is_some())
            .map(|h| self.pane_header_label(h, width))
            .collect()
    }
}
