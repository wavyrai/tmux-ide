//! Quitting while a native SSH owner is live.
use super::browser;
use gpui::App;
use std::rc::Rc;

// Normal Quit/last-window-close waits off-thread before asking macOS to exit.
// GPUI's final shutdown hook has only 200 ms, less than SSH's TERM grace period.
pub(super) fn request_native_quit(
    owner: Option<browser::NativeOwner>,
    closing: Rc<std::cell::Cell<bool>>,
    cx: &mut App,
) {
    let Some(owner) = owner else {
        cx.quit();
        return;
    };
    if closing.replace(true) {
        return;
    }
    let cleanup = cx
        .background_executor()
        .spawn(async move { owner.shutdown() });
    cx.spawn(async move |cx| match cleanup.await {
        Ok(()) => {
            cx.update(|cx| cx.quit());
        }
        Err(error) => {
            eprintln!("tmux-ide: native SSH shutdown failed: {error}");
            closing.set(false);
        }
    })
    .detach();
}
