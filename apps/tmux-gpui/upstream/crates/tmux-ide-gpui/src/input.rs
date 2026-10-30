#[cfg(target_os = "linux")]
mod linux;
// The platform input handler for every view-backed text field. It is not named
// ElementInputHandler, so a `gpui::*` glob cannot silently replace it with
// GPUI's strong handler on Linux.
#[cfg(not(target_os = "linux"))]
pub(crate) use gpui::ElementInputHandler as ViewInputHandler;
#[cfg(target_os = "linux")]
pub(crate) use linux::WeakInputHandler as ViewInputHandler;

/// Elsewhere Alt has no sides that matter: it always reaches the pane.
#[cfg(not(target_os = "macos"))]
pub(crate) fn held_option_keys() -> crate::config::OptionKeys {
    crate::config::OptionKeys::LEFT
}
