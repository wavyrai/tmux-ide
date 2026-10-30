//! Window commands the tmux path shares with the native titlebar.
use crate::controls::Command;
use gpui::Window;

pub(crate) fn run_window_command(
    command: Command,
    window: &mut Window,
    cx: &mut gpui::App,
) -> bool {
    match command {
        Command::ToggleFullScreen => window.toggle_fullscreen(),
        Command::CycleWindows => cycle_windows(window, cx),
        _ => return false,
    }
    true
}

/// Brings the app's next window forward, in the stable order the app lists
/// its windows, as macOS's Cmd-` does: a front-to-back order would only ever
/// swap the two most recent. Deferred, since activating a window updates it.
fn cycle_windows(window: &Window, cx: &mut gpui::App) {
    let Some(next) = next_window(&cx.windows(), window.window_handle()) else {
        return;
    };
    cx.defer(move |cx| {
        next.update(cx, |_, window, _| window.activate_window())
            .ok();
    });
}

/// The window after `current` in `windows`, wrapping; none when `current`
/// is alone or unknown.
fn next_window<T: Copy + PartialEq>(windows: &[T], current: T) -> Option<T> {
    let at = windows.iter().position(|window| *window == current)?;
    let next = windows[(at + 1) % windows.len()];
    (next != current).then_some(next)
}
