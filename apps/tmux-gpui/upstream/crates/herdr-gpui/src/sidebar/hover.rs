//! Resting the pointer on a row to open its menu, and leaving it to close it
//! again. The rest and the menu it opened are tracked separately so a small
//! pointer jitter inside the slop does not cancel a pending open. The whole
//! behavior is behind the `features.sidebar_hover_menu` config flag, off by
//! default: without it, only a right click opens a row's menu.

use super::{HOVER_MENU_DELAY, HOVER_MENU_SLOP};
use crate::HerdrWindow;
use gpui::{Context, Pixels, Point, Window, px};
use std::time::Instant;

pub(crate) struct HoverRest {
    pub(crate) workspace: String,
    pub(crate) position: Point<Pixels>,
    /// Where the list stood when the row was entered. Scrolling slides other
    /// rows under a still pointer, so a changed offset voids this dwell.
    pub(crate) scroll: Point<Pixels>,
    pub(crate) since: Instant,
    /// The pointer has moved since it entered the row. Dismissing a menu leaves
    /// the pointer where it was, so without this the menu would reopen under it.
    pub(crate) moved: bool,
}

/// A menu the pointer opened by resting. It closes again as soon as the pointer
/// moves anywhere but into it, so a menu nobody asked for needs no click to go.
pub(crate) struct HoverMenu {
    /// Where the pointer stood when the menu opened.
    pub(crate) position: Point<Pixels>,
    /// The pointer is over the popup. Only its own hover reports this: the popup
    /// may be snapped away from the pointer that opened it.
    pub(crate) inside: bool,
}

impl HerdrWindow {
    pub(super) fn save_sidebar_width(&mut self) {
        self.sidebar_modified = true;
        self.save_chrome();
    }

    /// One file holds the whole chrome, so every save carries all fields.
    pub(crate) fn save_chrome(&self) {
        if let Some(preferences) = &self.sidebar_preferences {
            preferences.save(crate::preferences::Chrome {
                sidebar_width: self.sidebar_width,
                sidebar_split: self.sidebar_split,
                agent_sort: self.agent_sort_modified.then_some(self.agent_sort),
                notes_width: self.notes_width.chosen(),
                review_files_width: self.review_files_width.chosen(),
            });
        }
    }

    /// Track the workspace row under the pointer. Entering a row restarts its
    /// dwell; leaving the row it recorded abandons it.
    pub(crate) fn hover_workspace(&mut self, workspace: &str, hovered: bool, window: &Window) {
        if !hovered {
            if self
                .hover
                .as_ref()
                .is_some_and(|hover| hover.workspace == workspace)
            {
                self.hover = None;
            }
            return;
        }
        // A pointer carrying a row is not resting on the rows it passes.
        if self
            .workspace_drag
            .as_ref()
            .is_some_and(super::WorkspaceDrag::floating)
        {
            return;
        }
        self.hover = Some(HoverRest {
            workspace: workspace.to_owned(),
            position: window.mouse_position(),
            scroll: self.sidebar_scroll[0].offset(),
            since: Instant::now(),
            moved: false,
        });
    }

    /// Open the hovered row's menu once the pointer has settled on it. Called
    /// from the frame poll with that frame's time, so the dwell is testable
    /// without waiting for it.
    pub(crate) fn poll_hover_menu(
        &mut self,
        now: Instant,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let position = window.mouse_position();
        if self.close_hover_menu(position, window, cx) {
            return;
        }
        // A config reload can retire the feature under an armed pointer. An
        // already open menu still closes above, by its own rules.
        if !self.config.features.sidebar_hover_menu {
            self.hover = None;
            return;
        }
        let scroll = self.sidebar_scroll[0].offset();
        let Some(hover) = &mut self.hover else {
            return;
        };
        if hover.scroll != scroll {
            self.hover = None;
            return;
        }
        let drift = position - hover.position;
        if drift.x.abs() > px(HOVER_MENU_SLOP) || drift.y.abs() > px(HOVER_MENU_SLOP) {
            hover.position = position;
            hover.since = now;
            hover.moved = true;
            return;
        }
        if !hover.moved || now.saturating_duration_since(hover.since) < HOVER_MENU_DELAY {
            return;
        }
        // One shot: the pointer must enter a row again before another menu opens,
        // so dismissing this one under a still pointer cannot reopen it.
        let Some(hover) = self.hover.take() else {
            return;
        };
        if !self.active || self.menu.page.is_some() || !self.live.status.is_connected() {
            return;
        }
        self.open_workspace_menu(&hover.workspace, position, window, cx);
        self.hover_menu = Some(HoverMenu {
            position,
            inside: false,
        });
    }

    /// Close a menu the pointer opened once the pointer leaves it. Reports
    /// whether it closed one.
    fn close_hover_menu(
        &mut self,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(open) = &self.hover_menu else {
            return false;
        };
        // Choosing an action leaves the pointer's claim behind: a dialog is
        // dismissed by its own buttons, never by moving the mouse away.
        if self.menu.page != Some(crate::menu::Page::Workspace) {
            self.hover_menu = None;
            return false;
        }
        let drift = position - open.position;
        if open.inside
            || (drift.x.abs() <= px(HOVER_MENU_SLOP) && drift.y.abs() <= px(HOVER_MENU_SLOP))
        {
            return false;
        }
        // The row the pointer moved on to keeps its own dwell, so leaving one
        // menu for the next row still opens that row's menu.
        let resting = self.hover.take();
        self.dismiss_menu(window, cx);
        self.hover = resting;
        true
    }
}
