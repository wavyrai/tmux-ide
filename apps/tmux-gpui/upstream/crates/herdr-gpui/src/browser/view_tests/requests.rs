use super::*;
use crate::control::{Placed, Target};

/// Opens a request's tab without switching to it, so no native page is made.
fn request(
    view: &Entity<HerdrWindow>,
    cx: &mut VisualTestContext,
    daemon: Option<&str>,
    workspace: Option<&str>,
    strict: bool,
) -> Option<Placed> {
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let target = Target {
                daemon: daemon.map(std::path::Path::new),
                workspace,
                pane: Some("w0:p1"),
            };
            view.open_requested_browser_tab(
                &target,
                strict,
                &url("http://localhost:3000/"),
                false,
                window,
                cx,
            )
        })
    })
}

#[gpui::test]
fn requests_open_tabs_only_in_a_workspace_the_window_shows(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx);
    let socket = view.read_with(cx, |view, _| {
        view.endpoints[0]
            .connection
            .target
            .socket_path()
            .ok()
            .map(|path| path.to_string_lossy().into_owned())
    });
    // No named workspace: the one the window shows.
    assert!(matches!(
        request(&view, cx, None, None, true),
        Some(Placed::Opened { workspace_id }) if workspace_id == "w0"
    ));
    assert!(matches!(
        request(&view, cx, None, Some("w1"), true),
        Some(Placed::Opened { workspace_id }) if workspace_id == "w1"
    ));
    assert!(request(&view, cx, None, Some("w_missing"), true).is_none());
    // Another daemon's socket never matches strictly, but its workspace ID
    // still finds the window once socket spellings are ignored.
    assert!(
        request(
            &view,
            cx,
            Some("/elsewhere/herdr-client.sock"),
            Some("w0"),
            true
        )
        .is_none()
    );
    assert!(
        request(
            &view,
            cx,
            Some("/elsewhere/herdr-client.sock"),
            Some("w0"),
            false
        )
        .is_some()
    );
    assert!(request(&view, cx, Some("/elsewhere/herdr-client.sock"), None, false).is_none());
    if let Some(socket) = socket {
        assert!(request(&view, cx, Some(&socket), Some("w0"), true).is_some());
    }
    // Opened without focus: the terminal stays in front.
    draw(cx);
    assert!(cx.debug_bounds("terminal").is_some());
    assert!(cx.debug_bounds("browser-tab-0").is_some());
    // The same pane showing the same page again got its tab back each time:
    // one tab in w0 and one in w1.
    cx.update(|_, cx| {
        let store = cx.global::<Store>();
        assert_eq!(store.opened_by("w0:p1").count(), 2);
    });
}
