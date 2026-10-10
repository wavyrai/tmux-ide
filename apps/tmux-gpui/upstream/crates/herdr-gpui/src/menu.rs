//! The window's menu popups: the pages they show, the state they own, and the
//! workspace operations they carry to the daemon. Input is isolated to the
//! popup while one is open, and every modal action is fenced by the connection
//! it was started under.

mod checkpoints;
mod chrome;
mod colors;
mod devices;
mod fan_out;
mod git;
mod github;
mod page;
mod pr;
mod pr_actions;
mod sessions;
mod settings;
mod state;
mod teleport;
mod version_mismatch;
mod whats_new;
mod workspace;
mod workspace_close;
mod worktree_note;
mod worktree_open;
mod worktree_render;
mod worktree_source;

#[cfg(test)]
mod announcement_tests;
#[cfg(test)]
mod font_size_tests;
#[cfg(test)]
mod sessions_tests;
#[cfg(test)]
mod version_mismatch_tests;
#[cfg(test)]
pub(crate) mod workspace_tests;
#[cfg(test)]
mod worktree_open_tests;
#[cfg(test)]
mod worktree_tests;

/// Only builds that show pages, and tests, ask what a menu covers.
#[cfg(any(target_os = "macos", windows, test))]
pub(crate) use state::Cover;
pub(crate) use {
    colors::{accent, danger, online, teleported, tint},
    page::{Page, WorkspaceAction},
    state::{MenuState, Removal},
    version_mismatch::Notice as VersionNotice,
    worktree_source::WorktreeSource,
};

pub(crate) use devices::enter as enter_key;
use page::WorkspaceMenuAction;
use state::Submission;
use workspace::WorkspaceTarget;

/// Shared trailing action geometry for pickers and workspace context menus.
fn action_icon(
    path: &'static str,
    selector: String,
    color: gpui::Rgba,
    hover_color: gpui::Rgba,
) -> gpui::Div {
    use gpui::{prelude::*, *};
    div()
        .group("menu-action-icon")
        .size(px(24.))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(crate::config::corners::CONTROL))
        .child(
            svg()
                .path(path)
                .size(px(14.))
                // GPUI skips SVG painting without an explicit color on the SVG;
                // the parent's text color is not inherited by SVG painting.
                .text_color(color)
                .group_hover("menu-action-icon", move |s| s.text_color(hover_color))
                .debug_selector(move || selector.clone()),
        )
}

/// Breathing room between a popup and the window's edges, so a list that had
/// to be clamped still shows that it stops short of the frame.
const MENU_MARGIN: f32 = 8.;

/// Daemon failures arrive as an open envelope. Keep the code so callers can
/// classify the refusal, and the message for display.
fn endpoint_error(error: &serde_json::Value) -> (&str, &str) {
    (
        error["code"].as_str().unwrap_or("endpoint_error"),
        error["message"].as_str().unwrap_or("Invalid daemon error"),
    )
}
