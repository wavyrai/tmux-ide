//! Display labels never become routing identities.
use super::browser::State;
#[path = "agent_icon.rs"]
mod agent_icon;
#[path = "browser_icon.rs"]
pub(super) mod browser_icon;
pub(super) use agent_icon::path as agent_icon_path;
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
#[cfg(test)]
use std::sync::Arc;
#[derive(Default)]
pub(super) struct Controls {
    pending: Option<(u64, String, String)>,
    intent: HeaderIntent,
}
#[derive(Clone, Copy, Default)]
enum HeaderIntent {
    #[default]
    Menu,
    Expand,
    Close,
}
mod buttons;
const OVERFLOW_WIDTH: f32 = 24.;
fn action_width(header: &Header, width: f32) -> f32 {
    if f32::from(header.width) * width >= 160. {
        56.
    } else {
        0.
    }
}
const MODE_WIDTH: f32 = 56.;
fn has_mode(header: &Header, width: f32) -> bool {
    has_control(header, width)
        && header.width >= 14
        && f32::from(header.width) * width >= MODE_WIDTH + OVERFLOW_WIDTH + 12.
}
fn has_control(header: &Header, width: f32) -> bool {
    width.is_finite()
        && width > 0.
        && header.width >= 7
        && f32::from(header.width) * width >= OVERFLOW_WIDTH + 12.
}

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
        || frame.view().width() > 1000
        || frame.view().height() > 500
        || frame.view().has_inline_graphics()
        || !hit_regions::valid_view(&state.regions, Some(frame.view()), &state.panes)
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
    frame: &super::display_frame::DisplayFrame,
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
        && !view.resize_gesture.busy()
        && hit_regions::is_painted(Some(frame), view.frame.as_ref())
        && hit_regions::is_painted(Some(frame), view.painted_frame.as_ref())
        && publication_current(&view.browser_state, request, frame, regions, id)
}
fn publication_current(
    state: &State,
    request: u64,
    frame: &super::display_frame::DisplayFrame,
    regions: &[hit_regions::Region],
    id: &str,
) -> bool {
    state.request == request
        && hit_regions::is_painted(Some(frame), state.frame.as_ref())
        && state.regions == regions
        && hit_regions::valid_view(&state.regions, Some(frame.view()), &state.panes)
        && state.regions.iter().any(|r| r.id == id)
}
impl SnapshotView {
    fn header_mode_visible(&self, header: &Header, width: f32) -> bool {
        has_mode(header, width)
            && self.browser_state.selected_pane.as_ref() == Some(&header.id)
            && (self.browser_state.history_offset > 0
                || (action_width(header, width) == 0.
                    && self
                        .browser_state
                        .pane_actions
                        .as_ref()
                        .is_some_and(|a| a.zoomed)))
    }
    fn header_rect(&self, header: &Header, width: f32) -> Bounds<Pixels> {
        if let Some(mut layout) = self.card_layout(width) {
            if let Some(preview) = self.divider_content_preview() {
                layout = layout.reflow(&preview.regions);
            }
            if let Some(r) = layout.regions.iter().find(|r| r.id == header.id) {
                let mut bounds = layout.card(r);
                bounds.size.height = px(super::pane_cards::HEADER);
                return bounds;
            }
        }
        Bounds::new(
            point(
                px(f32::from(header.left) * width),
                px(header
                    .row
                    .map_or(0., |r| f32::from(r) * self.terminal_height())),
            ),
            size(
                px(f32::from(header.width) * width),
                px(self.terminal_height()),
            ),
        )
    }
    fn activate_header_menu(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.browser_state.selected_pane.as_deref() == Some(id) {
            self.perform_header_intent(window, cx);
            return;
        }
        let Some(session) = self.browser_state.selected_session.clone() else {
            return;
        };
        let old_request = self.browser_request;
        let intent = self.header_controls.intent;
        self.select(Selection::Pane(id.to_owned()), window, cx);
        if self.browser_request != old_request {
            self.header_controls.intent = intent;
            self.header_controls.pending = Some((self.browser_request, session, id.to_owned()));
        }
    }
    pub(super) fn finish_header_actions(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((request, session, id)) = self.header_controls.pending.clone() else {
            return;
        };
        if self.browser_request != request
            || !self.presence.active()
            || self.browser_commands.is_none()
            || self.picker.is_some()
            || self.pane_actions.is_some()
            || self.new_session.is_some()
        {
            self.header_controls = Default::default();
            return;
        }
        if self.browser_state.request != request {
            return;
        }
        if self.browser_state.selected_session.as_ref() != Some(&session)
            || self.browser_state.selected_pane.as_ref() != Some(&id)
            || !self.browser_state.panes.iter().any(|p| p.id == id)
        {
            self.header_controls = Default::default();
            return;
        }
        if self.presence.ready()
            && super::pane_actions::Target::capture(&self.browser_state).is_some()
        {
            self.header_controls.pending = None;
            self.perform_header_intent(window, cx);
        }
    }
    fn header_mode(
        &self,
        header: &Header,
        width: f32,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !has_mode(header, width)
            || self.browser_state.selected_pane.as_deref() != Some(&header.id)
        {
            return None;
        }
        let history = self.browser_state.history_offset;
        let target = super::pane_actions::Target::capture(&self.browser_state);
        let restore = self
            .browser_state
            .pane_actions
            .as_ref()
            .is_some_and(|a| a.zoomed);
        if history == 0 && (!restore || target.is_none() || action_width(header, width) > 0.) {
            return None;
        }
        let frame = self.browser_state.frame.clone()?;
        let regions = self.browser_state.regions.clone();
        let request = self.browser_request;
        let id = header.id.clone();
        let theme = self.theme();
        Some(
            div()
                .id(SharedString::from(format!("pane-mode:{id}")))
                .debug_selector({
                    let id = id.clone();
                    move || format!("pane-mode:{id}")
                })
                .absolute()
                .left(px(f32::from(self.header_rect(header, width).right())
                    - OVERFLOW_WIDTH
                    - MODE_WIDTH
                    - action_width(header, width)))
                .top(self.header_rect(header, width).origin.y)
                .w(px(MODE_WIDTH))
                .h(self.header_rect(header, width).size.height)
                .overflow_hidden()
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(10.))
                .text_color(rgb(theme.foreground))
                .rounded(px(crate::config::corners::CONTROL))
                .occlude()
                .cursor_pointer()
                .child(if history > 0 {
                    "Back to live"
                } else {
                    "Restore"
                })
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |view, _, window, cx| {
                    cx.stop_propagation();
                    if !current_header(view, request, &frame, &regions, &id)
                        || view.browser_state.selected_pane.as_ref() != Some(&id)
                    {
                        return;
                    }
                    if history > 0 && view.browser_state.history_offset == history {
                        view.return_to_live(window, cx);
                    } else if history == 0
                        && let Some(target) = &target
                    {
                        view.dispatch_captured_pane_action(
                            target,
                            super::pane_actions::Action::Zoom {
                                desired: super::pane_actions::Zoom::Unzoomed,
                            },
                            window,
                            cx,
                        );
                    }
                }))
                .into_any_element(),
        )
    }
    fn header_overflow(
        &self,
        header: &Header,
        width: f32,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !has_control(header, width) {
            return None;
        }
        let frame = self.browser_state.frame.clone()?;
        let regions = self.browser_state.regions.clone();
        let request = self.browser_request;
        let id = header.id.clone();
        let theme = self.theme();
        Some(
            div()
                .id(SharedString::from(format!("pane-overflow:{id}")))
                .role(Role::Button)
                .aria_label("More pane actions")
                .tooltip(|window, cx| {
                    bezel_ui::tooltip::Tooltip::text("More pane actions", window, cx)
                })
                .debug_selector({
                    let id = id.clone();
                    move || format!("pane-overflow:{id}")
                })
                .absolute()
                .left(px(f32::from(self.header_rect(header, width).right())
                    - OVERFLOW_WIDTH
                    - action_width(header, width)))
                .top(self.header_rect(header, width).origin.y)
                .w(px(OVERFLOW_WIDTH))
                .h(self.header_rect(header, width).size.height)
                .overflow_hidden()
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(12.))
                .text_color(rgb(theme.muted))
                .rounded(px(crate::config::corners::CONTROL))
                .cursor_pointer()
                .occlude()
                .child(
                    svg()
                        .path("icons/more.svg")
                        .size(px(14.).min(px(self.terminal_height())))
                        .text_color(rgb(theme.muted)),
                )
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |view, _, window, cx| {
                    cx.stop_propagation();
                    if current_header(view, request, &frame, &regions, &id) {
                        view.header_controls.intent = HeaderIntent::Menu;
                        view.activate_header_menu(&id, window, cx);
                    }
                }))
                .into_any_element(),
        )
    }
    pub(super) fn lower_pane_header_controls(
        &self,
        width: f32,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        if self.selection.is_some()
            || self.picker.is_some()
            || self.pane_actions.is_some()
            || self.new_session.is_some()
            || self.divider.is_some()
            || self.resize_gesture.busy()
        {
            return Vec::new();
        }
        self.presentation_headers()
            .iter()
            .filter(|h| h.row.is_some())
            .flat_map(|h| {
                [
                    self.header_overflow(h, width, cx),
                    self.header_mode(h, width, cx),
                    self.header_button(h, width, HeaderIntent::Expand, cx),
                    self.header_button(h, width, HeaderIntent::Close, cx),
                ]
                .into_iter()
                .flatten()
            })
            .collect()
    }
    pub(super) fn pane_header_row(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.prepare_terminal_font();
        let width =
            self.painter
                .borrow_mut()
                .cell_width(&self.terminal_font.config.font(), window, cx);
        let theme = self.theme();
        let mut row = div()
            .id("pane-header-row")
            .debug_selector(|| "pane-header-row".into())
            .relative()
            .w_full()
            .h(px(self.terminal_height()))
            .flex_shrink_0()
            .overflow_hidden()
            .bg(rgb(theme.background));
        if !hit_regions::is_painted(self.frame.as_ref(), self.browser_state.frame.as_ref())
            || self.selection.is_some()
        {
            return row.into_any_element();
        }
        for header in self
            .presentation_headers()
            .into_iter()
            .filter(|h| h.row.is_none())
        {
            let request = self.browser_request;
            let Some(frame) = self.browser_state.frame.clone() else {
                continue;
            };
            let regions = self.browser_state.regions.clone();
            let id = header.id.clone();
            let overflow = (!self.resize_gesture.busy())
                .then(|| self.header_overflow(&header, width, cx))
                .flatten();
            let mode = (!self.resize_gesture.busy())
                .then(|| self.header_mode(&header, width, cx))
                .flatten();
            row = row
                .child(
                    self.pane_header_label(&header, width, self.browser_header(&header.id, cx))
                        .id(SharedString::from(format!("pane-header:{}", header.id)))
                        .cursor_pointer()
                        .on_click(cx.listener(move |view, _, window, cx| {
                            if current_header(view, request, &frame, &regions, &id) {
                                if view.browser_state.selected_pane.as_ref() != Some(&id)
                                    || view.browser_state.input_target_rejected
                                {
                                    view.select(Selection::Pane(id.clone()), window, cx);
                                } else {
                                    // Focus alone never restores interrupted input authority.
                                    view.terminal_focus.focus(window, cx);
                                }
                            }
                        })),
                )
                .children(overflow)
                .children(mode)
                .children(self.header_button(&header, width, HeaderIntent::Expand, cx))
                .children(self.header_button(&header, width, HeaderIntent::Close, cx));
        }
        row.into_any_element()
    }
    fn pane_header_label(&self, header: &Header, width: f32, browser: Option<AnyElement>) -> Div {
        let agent = self
            .browser_state
            .workspace_agents
            .as_ref()
            .and_then(|workspace| {
                if self.browser_state.selected_session.as_ref() != Some(&workspace.session_id) {
                    return None;
                }
                let mut rows = workspace.roster.rows.iter().filter(|row| {
                    row.session_id == workspace.session_id
                        && row.pane_id.as_deref() == Some(&header.id)
                });
                let row = rows.next()?;
                if rows.next().is_some() {
                    return None;
                }
                Some((
                    row,
                    !row.available
                        || !matches!(
                            workspace.roster.phase,
                            super::browser::home_agents::Phase::Live
                                | super::browser::home_agents::Phase::Partial
                        ),
                ))
            });
        let indicator = agent
            .filter(|_| header.width >= 20)
            .map(|(row, unavailable)| self.agent_indicator(row, unavailable));
        let icon = agent_icon_path(
            agent
                .filter(|(_, unavailable)| !unavailable)
                .and_then(|(row, _)| row.harness.as_deref()),
        );
        let browser_icon = self
            .browser_state
            .panes
            .iter()
            .find(|pane| pane.id == header.id)
            .and_then(|pane| pane.browser_icon.as_deref());
        let selected = self.browser_state.selected_pane.as_deref() == Some(&header.id);
        let theme = self.theme();
        // Herdr sidebar/row.rs label budgeting and selection styling, rendered
        // with native elements. Never insert title glyphs into terminal cells.
        div()
            .absolute()
            .left(self.header_rect(header, width).origin.x)
            .top(self.header_rect(header, width).origin.y)
            .w(self.header_rect(header, width).size.width)
            .h(self.header_rect(header, width).size.height)
            .min_w_0()
            .overflow_hidden()
            .px(px(if self.card_layout(width).is_some() {
                super::pane_cards::PAD
            } else {
                width.min(4.)
            }))
            .when(has_control(header, width), |label| {
                label.pr(px(OVERFLOW_WIDTH
                    + action_width(header, width)
                    + if self.header_mode_visible(header, width) {
                        MODE_WIDTH + 2.
                    } else {
                        2.
                    }))
            })
            .when(self.card_layout(width).is_none(), |label| {
                label.bg(rgb(theme.background))
            })
            .text_color(rgb(if selected {
                theme.foreground
            } else {
                theme.muted
            }))
            .text_size(px((self.terminal_height() - 2.).min(12.)))
            .font_weight(if selected {
                FontWeight::SEMIBOLD
            } else {
                FontWeight::NORMAL
            })
            .flex()
            .items_center()
            .gap(px(4.))
            .child(browser_icon::element(
                browser_icon,
                icon,
                (self.terminal_height() - 2.).clamp(8., 14.),
                if selected {
                    theme.foreground
                } else {
                    theme.muted
                },
            ))
            .children(indicator)
            .child(browser.unwrap_or_else(|| {
                // The pane's title as a Bezel tab: focused for the selected
                // pane, resting otherwise, at the header's cell height.
                bezel_ui::tabs::tab(
                    &super::design::palette(&theme),
                    format!("pane-title:{}", header.id),
                    bezel_ui::tabs::Label::new(label(&self.browser_state, &header.id)),
                    if selected {
                        bezel_ui::tabs::State::Focused
                    } else {
                        bezel_ui::tabs::State::Resting
                    },
                )
                .h_full()
                .min_w_0()
                .flex_shrink(1.)
                .text_size(px((self.terminal_height() - 2.).min(12.)))
                .into_any_element()
            }))
    }
    pub(super) fn pane_header_labels(&self, width: f32, cx: &mut Context<Self>) -> Vec<AnyElement> {
        if self.card_layout(width).is_none() {
            return self
                .lower_pane_headers(width)
                .into_iter()
                .map(IntoElement::into_any_element)
                .collect();
        }
        if !hit_regions::is_painted(self.frame.as_ref(), self.browser_state.frame.as_ref()) {
            return Vec::new();
        }
        self.presentation_headers()
            .iter()
            .map(|h| {
                let id = h.id.clone();
                let frame = self.browser_state.frame.clone();
                let regions = self.browser_state.regions.clone();
                let request = self.browser_request;
                self.pane_header_label(h, width, self.browser_header(&h.id, cx))
                    .id(SharedString::from(format!("pane-card-header:{id}")))
                    .debug_selector({
                        let id = id.clone();
                        move || format!("pane-card-header:{id}")
                    })
                    .occlude()
                    .cursor_pointer()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |view, _, window, cx| {
                        cx.stop_propagation();
                        if frame.as_ref().is_some_and(|frame| {
                            current_header(view, request, frame, &regions, &id)
                        }) {
                            if view.browser_state.selected_pane.as_ref() != Some(&id)
                                || view.browser_state.input_target_rejected
                            {
                                view.select(Selection::Pane(id.clone()), window, cx);
                            } else {
                                view.terminal_focus.focus(window, cx);
                            }
                        }
                    }))
                    .into_any_element()
            })
            .collect()
    }
    pub(super) fn lower_pane_headers(&self, width: f32) -> Vec<Div> {
        if self.selection.is_some()
            || !hit_regions::is_painted(self.frame.as_ref(), self.browser_state.frame.as_ref())
        {
            return Vec::new();
        }
        // Labels remain pass-through. Only the separately rendered trailing controls
        // occlude their reserved rectangles; the remaining separator still drags.
        self.presentation_headers()
            .iter()
            .filter(|h| h.row.is_some())
            .map(|h| self.pane_header_label(h, width, None))
            .collect()
    }
    fn presentation_headers(&self) -> Vec<Header> {
        let mut result = if self
            .card_layout(self.input_cell_width.unwrap_or(8.))
            .is_some()
        {
            self.browser_state
                .regions
                .iter()
                .map(|r| Header {
                    id: r.id.clone(),
                    left: r.left,
                    width: r.width,
                    row: Some(r.top),
                })
                .collect()
        } else {
            headers(&self.browser_state)
        };
        if let Some(preview) = self.divider_content_preview() {
            for header in &mut result {
                if let Some(region) = preview.regions.iter().find(|r| r.id == header.id) {
                    header.left = region.left;
                    header.width = region.width;
                    header.row = region.top.checked_sub(1);
                }
            }
        }
        result
    }
}
