//! The gliding cursor in the view: its setting (on by default, saved in
//! the same format as Developer mode) and what a glide may not cross.
use super::{SnapshotView, developer_mode, display_frame::DisplayFrame};
use crate::terminal_painter::{CursorCell, CursorTarget, FrameView, TerminalPainter};
use gpui::{Context, Window};
use std::{
    cell::RefCell,
    hash::{Hash, Hasher},
    io,
    path::PathBuf,
};

pub(super) struct Setting {
    pub enabled: bool,
    pub ready: bool,
    pub saving: bool,
    pub note: Option<&'static str>,
    started: bool,
    path: Option<PathBuf>,
}

impl Default for Setting {
    fn default() -> Self {
        Self {
            enabled: true,
            ready: false,
            saving: false,
            note: None,
            started: false,
            path: None,
        }
    }
}

impl Setting {
    pub(super) fn load(path: Option<PathBuf>) -> Self {
        let mut setting = Self {
            ready: true,
            started: true,
            path,
            ..Self::default()
        };
        if let Some(path) = &setting.path {
            match developer_mode::read(path) {
                Ok(saved) => setting.enabled = saved.enabled,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(_) => setting.note = Some("Saved cursor animation unavailable; using On"),
            }
        }
        setting
    }
}

/// The scene the cursor sits in. A glide never crosses a change of it: the
/// pane or session, window focus, the grid's size, the alternate screen
/// (as far as the pane reports it), scrollback, or a resize preview.
fn scene(view: &SnapshotView, frame: FrameView<'_>, previewing: bool, active: bool) -> u64 {
    let state = &view.browser_state;
    let mut hasher = std::hash::DefaultHasher::new();
    (
        &state.selected_session,
        &state.selected_pane,
        state.pointer_modes.map(|modes| modes.alternate),
        state.history_offset,
        (frame.width(), frame.height()),
        previewing,
        active,
    )
        .hash(&mut hasher);
    hasher.finish()
}

/// What the painter's glide sees in `frame`.
pub(super) fn target(
    view: &SnapshotView,
    frame: FrameView<'_>,
    previewing: bool,
    active: bool,
    reduced_motion: bool,
) -> CursorTarget {
    CursorTarget {
        cell: frame
            .cursor()
            .filter(|c| c.visible && c.x < frame.width() && c.y < frame.height())
            .map(|c| CursorCell { x: c.x, y: c.y }),
        scene: scene(view, frame, previewing, active),
        animate: view.cursor_motion.enabled && !reduced_motion,
    }
}

impl SnapshotView {
    /// Before the terminal paints: tells the painter where the cursor is and
    /// asks for the next frame only while it still glides, so a still
    /// cursor schedules nothing.
    pub(super) fn glide_cursor<Preview>(
        &self,
        painter: &RefCell<TerminalPainter>,
        frame: &DisplayFrame,
        preview: &Option<Preview>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        use bezel_motion::AppExt as _;
        // macOS Reduce Motion, as the chrome hands it to gpui each render.
        let reduced = cx.reduced_motion();
        let active = window.is_window_active();
        let target = target(self, frame.view(), preview.is_some(), active, reduced);
        if painter
            .borrow_mut()
            .cursor_glide
            .observe(target, cx.background_executor().now())
        {
            cx.on_next_frame(window, |_, _, cx| cx.notify());
        }
    }

    pub(super) fn load_cursor_motion(&mut self, cx: &mut Context<Self>) {
        if self.cursor_motion.started {
            return;
        }
        self.cursor_motion.started = true;
        let task = cx
            .background_executor()
            .spawn(async { Setting::load(developer_mode::config_path("gpui-cursor.json")) });
        cx.spawn(async move |view, cx| {
            let setting = task.await;
            let _ = view.update(cx, |view, cx| {
                view.cursor_motion = setting;
                view.refresh_picker(cx);
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn set_cursor_motion(&mut self, enabled: bool, cx: &mut Context<Self>) {
        let setting = &mut self.cursor_motion;
        if !setting.ready || setting.saving || setting.enabled == enabled {
            return;
        }
        let Some(path) = setting.path.clone() else {
            setting.note = Some("Settings location unavailable; previous setting retained");
            cx.notify();
            return;
        };
        setting.saving = true;
        setting.note = Some("Saving cursor animation…");
        cx.notify();
        let task = cx
            .background_executor()
            .spawn(async move { developer_mode::write(&path, enabled) });
        cx.spawn(async move |view, cx| {
            let result = task.await;
            let _ = view.update(cx, |view, cx| {
                let setting = &mut view.cursor_motion;
                setting.saving = false;
                if result.is_ok() {
                    setting.enabled = enabled;
                    setting.note = Some("Cursor animation saved");
                } else {
                    setting.note =
                        Some("Could not save cursor animation; previous setting retained");
                }
                view.refresh_picker(cx);
                cx.notify();
            });
        })
        .detach();
    }
}

#[cfg(test)]
#[path = "cursor_motion_tests.rs"]
mod tests;
